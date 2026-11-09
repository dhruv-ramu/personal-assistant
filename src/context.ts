import { loadConfig, type AppConfig } from "./config";
import { Db } from "./db/db";
import { SimClock, systemClock, type Clock } from "./domain/time";
import type { Env } from "./env";
import { log } from "./observability/log";
import { OpenAiPlanner } from "./providers/ai/openai";
import { GoogleCalendarProvider } from "./providers/calendar/google";
import { allowlistedFetch, type Fetcher } from "./providers/http";
import { SimulatedCalendarProvider } from "./providers/simulated/calendar";
import { RulePlanner } from "./providers/simulated/planner";
import { SimulatedSmsTransport } from "./providers/simulated/sms";
import { SimulatedVoiceTransport } from "./providers/simulated/voice";
import { TwilioSmsTransport } from "./providers/twilio/sms";
import { TwilioVoiceTransport } from "./providers/twilio/voice";
import type { CalendarProvider, Planner, SmsTransport, VoiceTransport } from "./providers/types";
import { UnconfiguredCalendarProvider, UnconfiguredPlanner, UnconfiguredSmsTransport, UnconfiguredVoiceTransport } from "./providers/unconfigured";
import { FieldCrypto } from "./security/crypto";
import { GoogleTokenSource } from "./services/calendar-connection";
import {
  D1SemanticIndex,
  HashEmbeddingProvider,
  LocalMediaStore,
  NwsInfoProvider,
  OpenAiEmbeddingProvider,
  OpenAiVisionAssessor,
  R2MediaStore,
  SimulatedEmailReader,
  SimulatedInfoProvider,
  SimulatedMmsFetcher,
  SimulatedVisionAssessor,
  TwilioMmsFetcher,
  VectorizeSemanticIndex,
  GmailReader,
  type EmailReader,
  type EmbeddingProvider,
  type InfoProvider,
  type MediaStore,
  type MmsMediaFetcher,
  type SemanticIndex,
  type VisionEvidenceAssessor,
} from "./ext/providers";
import { emailAccessToken } from "./ext/email";

export interface ExtProviders {
  media: MediaStore;
  embeddings: EmbeddingProvider;
  semantic: SemanticIndex;
  vision: VisionEvidenceAssessor;
  email: EmailReader;
  info: InfoProvider;
  mms: MmsMediaFetcher;
}

export interface JobDispatcher {
  publish(jobIds: string[]): Promise<void>;
}

export class QueueDispatcher implements JobDispatcher {
  constructor(private readonly queue: Queue<{ v: 1; jobId: string }>) {}
  async publish(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    await this.queue.sendBatch(jobIds.map((jobId) => ({ body: { v: 1 as const, jobId } })));
  }
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  clock: Clock;
  crypto: FieldCrypto;
  sms: SmsTransport;
  voice: VoiceTransport;
  calendar: CalendarProvider;
  planner: Planner;
  dispatcher: JobDispatcher;
  fetcher: Fetcher;
  /** Public origin used to build provider callback URLs. */
  baseUrl: string;
  ext: ExtProviders;
}

export interface ContextOverrides {
  clock?: Clock;
  dispatcher?: JobDispatcher;
  fetcher?: Fetcher;
  planner?: Planner;
  config?: AppConfig;
  ext?: Partial<ExtProviders>;
}

/** Simulator clock: when a frozen time is stored (non-production only), every component uses it. */
export async function loadClock(db: Db, config: AppConfig): Promise<Clock> {
  if (!config.simulatorEnabled) return systemClock;
  try {
    const row = await db.first<{ value: string }>("SELECT value FROM system_state WHERE key = 'sim_now'");
    return new SimClock(row && /^\d+$/.test(row.value) ? Number(row.value) : null);
  } catch (err) {
    log("warn", "sim_clock_unavailable", { error: String(err) });
  }
  return new SimClock(null);
}

function hasErrors(config: AppConfig, integration: "sms" | "voice" | "calendar" | "ai"): boolean {
  return config.issues.some((i) => i.severity === "error" && i.integration === integration);
}

export async function buildContext(env: Env, overrides: ContextOverrides = {}): Promise<AppContext> {
  const config = overrides.config ?? loadConfig(env);
  const db = new Db(env.DB);
  const clock = overrides.clock ?? (await loadClock(db, config));
  const crypto = new FieldCrypto(config.encryptionKey, config.previousEncryptionKeys);
  const fetcher = allowlistedFetch(overrides.fetcher);
  const baseUrl = config.publicBaseUrl ?? "http://localhost:8787";
  const requestBase = (req: Request) => config.publicBaseUrl ?? new URL(req.url).origin;
  const t = config.twilio;

  let sms: SmsTransport;
  if (config.providers.sms === "twilio") {
    sms =
      !hasErrors(config, "sms") && t.accountSid && t.authToken && t.phoneNumber && config.publicBaseUrl
        ? new TwilioSmsTransport(
            {
              accountSid: t.accountSid,
              authToken: t.authToken,
              phoneNumber: t.phoneNumber,
              messagingServiceSid: t.messagingServiceSid,
              publicBaseUrl: config.publicBaseUrl,
              providerManagedKeywords: t.providerManagedKeywords,
              live: config.flags.smsLive && config.flags.smsEligibilityConfirmed && !config.flags.dryRun,
            },
            fetcher,
          )
        : new UnconfiguredSmsTransport("twilio");
  } else {
    sms = new SimulatedSmsTransport(db, clock, config.simWebhookSecret, requestBase, config.appEnv !== "production");
  }

  let voice: VoiceTransport;
  if (config.providers.voice === "twilio") {
    voice =
      !hasErrors(config, "voice") && t.accountSid && t.authToken && t.phoneNumber && config.publicBaseUrl
        ? new TwilioVoiceTransport(
            {
              accountSid: t.accountSid,
              authToken: t.authToken,
              phoneNumber: t.phoneNumber,
              publicBaseUrl: config.publicBaseUrl,
              live: config.flags.voiceLive && !config.flags.dryRun,
            },
            fetcher,
          )
        : new UnconfiguredVoiceTransport("twilio");
  } else {
    voice = new SimulatedVoiceTransport(db, clock, config.simWebhookSecret, requestBase, config.appEnv !== "production");
  }

  let calendar: CalendarProvider;
  const g = config.google;
  if (config.providers.calendar === "google") {
    calendar =
      !hasErrors(config, "calendar") && g.clientId && g.clientSecret && g.redirectUri
        ? new GoogleCalendarProvider(
            new GoogleTokenSource(db, crypto, clock, fetcher, {
              clientId: g.clientId,
              clientSecret: g.clientSecret,
              redirectUri: g.redirectUri,
              expectedAccount: g.expectedAccount,
            }),
            fetcher,
          )
        : new UnconfiguredCalendarProvider("google");
  } else {
    calendar = new SimulatedCalendarProvider(db, clock);
  }

  let planner: Planner;
  if (overrides.planner) planner = overrides.planner;
  else if (config.providers.ai === "openai") {
    planner =
      !hasErrors(config, "ai") && config.openai.apiKey
        ? new OpenAiPlanner({ apiKey: config.openai.apiKey, model: config.openai.model, reasoningEffort: config.openai.reasoningEffort, enabled: config.flags.aiLive }, fetcher)
        : new UnconfiguredPlanner("openai");
  } else {
    planner = new RulePlanner(db);
  }

  const dispatcher = overrides.dispatcher ?? new QueueDispatcher(env.JOBS);
  const x = config.ext;
  const media: MediaStore = x.mediaStore === "r2" && env.MEDIA ? new R2MediaStore(env.MEDIA) : new LocalMediaStore(db, clock);
  const key = config.openai.apiKey;
  const ext: ExtProviders = {
    media,
    embeddings: x.embeddings === "openai" && key ? new OpenAiEmbeddingProvider(key, x.embeddingModel, fetcher) : new HashEmbeddingProvider(),
    semantic: x.semanticIndex === "vectorize" && env.VECTORS ? new VectorizeSemanticIndex(env.VECTORS) : new D1SemanticIndex(db, clock),
    vision: x.vision === "openai" && key ? new OpenAiVisionAssessor(key, x.visionModel, fetcher) : new SimulatedVisionAssessor(db),
    email:
      x.email === "gmail" && g.clientId && g.clientSecret
        ? new GmailReader(
            () =>
              emailAccessToken(db, crypto, clock, fetcher, { clientId: g.clientId!, clientSecret: g.clientSecret!, redirectUri: x.gmailRedirectUri ?? "", expectedAccount: null }),
            fetcher,
          )
        : new SimulatedEmailReader(db),
    info: x.info === "nws" && x.nwsContact ? new NwsInfoProvider(x.nwsContact, fetcher, clock) : new SimulatedInfoProvider(clock),
    mms: config.providers.sms === "twilio" && t.accountSid && t.authToken ? new TwilioMmsFetcher(t.accountSid, t.authToken, fetcher) : new SimulatedMmsFetcher(media),
    ...overrides.ext,
  };
  return { config, db, clock, crypto, sms, voice, calendar, planner, dispatcher, fetcher, baseUrl, ext };
}
