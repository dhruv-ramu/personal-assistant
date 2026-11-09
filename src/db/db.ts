/**
 * Thin typed wrapper over the D1 binding. All SQL is parameterized.
 *
 * D1 semantics relied upon (verified against Cloudflare docs, D1 Worker API):
 *  - `batch()` executes its prepared statements sequentially as one SQL transaction; if any
 *    statement fails the whole batch is rolled back.
 *  - Interactive transactions (BEGIN … COMMIT across awaits) are NOT available to Workers, so
 *    concurrency control uses conditional UPDATE/INSERT statements and `meta.changes` checks.
 */
export type SqlValue = string | number | null;

export class Db {
  constructor(readonly d1: D1Database) {}

  prepare(sql: string, ...params: SqlValue[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params);
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    return (await this.prepare(sql, ...params).first<T>()) ?? null;
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    const res = await this.prepare(sql, ...params).all<T>();
    return res.results ?? [];
  }

  /** Executes a write and returns the number of affected rows. */
  async run(sql: string, ...params: SqlValue[]): Promise<number> {
    const res = await this.prepare(sql, ...params).run();
    return res.meta.changes ?? 0;
  }

  /** Atomic batch (single transaction). Returns per-statement change counts. */
  async batch(statements: D1PreparedStatement[]): Promise<number[]> {
    if (statements.length === 0) return [];
    const results = await this.d1.batch(statements);
    return results.map((r) => r.meta.changes ?? 0);
  }
}

export function bool01(v: boolean): number {
  return v ? 1 : 0;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
