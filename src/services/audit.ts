import type { AppContext } from "../context";
import { newId } from "../security/crypto";
import { redactText } from "../security/redaction";

/** Redacted operational audit trail. Never pass message bodies or secrets as `detail`. */
export async function audit(
  ctx: AppContext,
  actor: "sms" | "admin" | "system" | "provider",
  action: string,
  entityType: string | null,
  entityId: string | null,
  detail = "",
): Promise<void> {
  await ctx.db.run(
    "INSERT INTO audit_log (id, actor, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    newId("aud"),
    actor,
    action,
    entityType,
    entityId,
    redactText(detail, 400),
    ctx.clock.now(),
  );
}

export function auditStatement(ctx: AppContext, actor: string, action: string, entityType: string | null, entityId: string | null, detail = ""): D1PreparedStatement {
  return ctx.db.prepare(
    "INSERT INTO audit_log (id, actor, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    newId("aud"),
    actor,
    action,
    entityType,
    entityId,
    redactText(detail, 400),
    ctx.clock.now(),
  );
}
