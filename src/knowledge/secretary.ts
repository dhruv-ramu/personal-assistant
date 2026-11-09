import type { AppContext } from "../context";
import { parseJson } from "../db/db";
import { stableId } from "../security/crypto";
import { jobInsertStatement } from "../services/jobs";
import { blindIndex, labelTokens, logMemoryEvent } from "./store";

export type SecretaryKind =
  | "promise"
  | "waiting_for"
  | "question"
  | "decision"
  | "prediction"
  | "accomplishment"
  | "checkpoint"
  | "idea"
  | "future_message"
  | "admin_item"
  | "recruiting"
  | "interaction"
  | "lesson"
  | "preference"
  | "note"
  | "trip"
  | "opportunity"
  | "interest"
  | "meeting_note";

export interface SecretaryRow {
  id: string;
  extraction_key: string | null;
  kind: SecretaryKind;
  status: string;
  title_enc: string;
  data_enc: string;
  person_id: string | null;
  project_id: string | null;
  task_id: string | null;
  due_at: number | null;
  check_at: number | null;
  trigger_kind: string | null;
  trigger_bidx: string | null;
  source_id: string | null;
  evidence_type: string;
  version: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  deleted_at: number | null;
}

export interface SecretaryItem extends SecretaryRow {
  title: string;
  data: Record<string, unknown>;
}

export async function decryptItem(ctx: AppContext, r: SecretaryRow): Promise<SecretaryItem> {
  return {
    ...r,
    title: await ctx.crypto.decrypt(r.title_enc, "secretary"),
    data: r.data_enc ? parseJson<Record<string, unknown>>(await ctx.crypto.decrypt(r.data_enc, "secretary"), {}) : {},
  };
}

export interface NewItem {
  key: string;
  kind: SecretaryKind;
  title: string;
  data?: Record<string, unknown>;
  personId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  dueAt?: number | null;
  checkAt?: number | null;
  triggerKind?: string | null;
  triggerText?: string | null;
  sourceId: string | null;
  status?: string;
  evidenceType?: string;
}

/** Idempotent per extraction key. A `check_at` schedules a `secretary_check` job. */
export async function createItem(ctx: AppContext, n: NewItem): Promise<{ item: SecretaryItem; created: boolean }> {
  const id = await stableId("sec", n.key);
  const existing = await ctx.db.first<SecretaryRow>("SELECT * FROM secretary_items WHERE id = ?", id);
  if (existing) return { item: await decryptItem(ctx, existing), created: false };
  const now = ctx.clock.now();
  const triggerBidx = n.triggerText ? await blindIndex(ctx, labelTokens(n.triggerText).sort().join(" ")) : null;
  const statements: D1PreparedStatement[] = [
    ctx.db.prepare(
      `INSERT OR IGNORE INTO secretary_items (id, extraction_key, kind, status, title_enc, data_enc, person_id, project_id, task_id, due_at, check_at, trigger_kind, trigger_bidx, source_id, evidence_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      n.key,
      n.kind,
      n.status ?? "open",
      await ctx.crypto.encrypt(n.title.slice(0, 300), "secretary"),
      await ctx.crypto.encrypt(JSON.stringify(n.data ?? {}), "secretary"),
      n.personId ?? null,
      n.projectId ?? null,
      n.taskId ?? null,
      n.dueAt ?? null,
      n.checkAt ?? null,
      n.triggerKind ?? null,
      triggerBidx,
      n.sourceId,
      n.evidenceType ?? "explicit_report",
      now,
      now,
    ),
    ctx.db.prepare("INSERT OR IGNORE INTO index_state (object_id, object_type, canonical_version, dirty, updated_at) VALUES (?, 'secretary', 1, 1, ?)", id, now),
  ];
  if (n.checkAt) {
    statements.push(
      jobInsertStatement(ctx, { logicalKey: `secretary_check:${id}:1`, kind: "secretary_check", entityId: id, entityGeneration: 1, dueAt: n.checkAt, maxAttempts: 3 }),
    );
  }
  await ctx.db.batch(statements);
  await logMemoryEvent(ctx, `secretary.${n.kind}.created`, { sourceId: n.sourceId });
  return { item: (await getItem(ctx, id))!, created: true };
}

export async function getItem(ctx: AppContext, id: string): Promise<SecretaryItem | null> {
  const r = await ctx.db.first<SecretaryRow>("SELECT * FROM secretary_items WHERE id = ? AND deleted_at IS NULL", id);
  return r ? decryptItem(ctx, r) : null;
}

export async function listItems(
  ctx: AppContext,
  kind: SecretaryKind | SecretaryKind[],
  opts: { status?: string[]; personId?: string; limit?: number } = {},
): Promise<SecretaryItem[]> {
  const kinds = Array.isArray(kind) ? kind : [kind];
  const params: Array<string | number> = [...kinds];
  let sql = `SELECT * FROM secretary_items WHERE deleted_at IS NULL AND kind IN (${kinds.map(() => "?").join(",")})`;
  if (opts.status) {
    sql += ` AND status IN (${opts.status.map(() => "?").join(",")})`;
    params.push(...opts.status);
  }
  if (opts.personId) {
    sql += " AND person_id = ?";
    params.push(opts.personId);
  }
  sql += " ORDER BY COALESCE(due_at, created_at) LIMIT ?";
  params.push(opts.limit ?? 50);
  const rows = await ctx.db.all<SecretaryRow>(sql, ...params);
  return Promise.all(rows.map((r) => decryptItem(ctx, r)));
}

export async function updateItem(
  ctx: AppContext,
  item: SecretaryItem,
  patch: { status?: string; data?: Record<string, unknown>; checkAt?: number | null; resolved?: boolean },
): Promise<boolean> {
  const now = ctx.clock.now();
  const data = patch.data ? await ctx.crypto.encrypt(JSON.stringify(patch.data), "secretary") : item.data_enc;
  const won = await ctx.db.run(
    "UPDATE secretary_items SET status = ?, data_enc = ?, check_at = ?, resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    patch.status ?? item.status,
    data,
    patch.checkAt !== undefined ? patch.checkAt : item.check_at,
    patch.resolved ? now : item.resolved_at,
    now,
    item.id,
    item.version,
  );
  if (won === 1) {
    await ctx.db.run("UPDATE index_state SET canonical_version = canonical_version + 1, dirty = 1, updated_at = ? WHERE object_id = ?", now, item.id);
    if (patch.checkAt) {
      await ctx.db.batch([
        jobInsertStatement(ctx, {
          logicalKey: `secretary_check:${item.id}:${item.version + 1}`,
          kind: "secretary_check",
          entityId: item.id,
          entityGeneration: item.version + 1,
          dueAt: patch.checkAt,
          maxAttempts: 3,
        }),
      ]);
    }
  }
  return won === 1;
}
