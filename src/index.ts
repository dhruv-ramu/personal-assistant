import { hasFatalCoreIssue } from "./config";
import { buildContext } from "./context";
import type { Env } from "./env";
import { createApp } from "./http/router";
import { log } from "./observability/log";
import { safeErrorMessage } from "./security/redaction";
import { markDeadLettered, parseQueueBody, processJob, type QueueMessageBody } from "./services/queue-consumer";
import { runTick } from "./services/scheduler";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /** Minute Cron: deterministic discovery and dispatch only (no AI calls). */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const appCtx = await buildContext(env);
    if (hasFatalCoreIssue(appCtx.config)) {
      log("error", "tick_skipped_fatal_configuration", {});
      return;
    }
    try {
      const report = await runTick(appCtx, controller.scheduledTime);
      log("info", "tick", { dispatched: report.dispatched, lagMs: report.lagMs, tasks: report.materialized.tasks, publishError: report.publishError });
    } catch (err) {
      log("error", "tick_failed", { error: safeErrorMessage(err) });
      throw err;
    }
  },

  /**
   * Queue consumer (configured for batch size 1, concurrency 1). D1 is the source of truth:
   * messages carry only a job ID; claims/fencing make duplicate deliveries harmless. Messages are
   * acked once D1 records the outcome; only a D1 failure triggers a queue retry (and eventually
   * the dead-letter queue, whose consumer marks the job dead for operator review).
   */
  async queue(batch: MessageBatch<QueueMessageBody>, env: Env): Promise<void> {
    const appCtx = await buildContext(env);
    const isDlq = batch.queue.includes("dlq");
    for (const msg of batch.messages) {
      const body = parseQueueBody(msg.body);
      if (!body) {
        log("warn", "queue_message_invalid", { queue: batch.queue });
        msg.ack();
        continue;
      }
      try {
        if (isDlq) await markDeadLettered(appCtx, body.jobId);
        else await processJob(appCtx, body.jobId);
        msg.ack();
      } catch (err) {
        log("error", "queue_processing_failed", { jobId: body.jobId, error: safeErrorMessage(err) });
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessageBody>;
