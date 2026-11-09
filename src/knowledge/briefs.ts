import type { AppContext } from "../context";
import { formatDate, formatTime, MINUTE } from "../domain/time";
import { featureOn, getExtSettings } from "../ext/settings";
import type { WeatherReport } from "../ext/providers";
import { newId } from "../security/crypto";
import { getSettings } from "../services/settings";
import { contextTasks } from "./planning";
import { listItems } from "./secretary";
import { cleanLabel } from "./resolve";

const WEATHER_TTL_MS = 60 * MINUTE;

/**
 * Current information is labelled with source and retrieval time, cached briefly, and never
 * stored as durable personal memory. Destinations are not geocoded: only the configured home
 * location can be looked up.
 */
export async function weatherLine(ctx: AppContext): Promise<string | null> {
  const ext = await getExtSettings(ctx.db);
  if (!featureOn(ctx, ext, "info")) return null;
  if (ext.location_lat === null || ext.location_lon === null) return "Weather: no location configured (set one in the dashboard).";
  const s = await getSettings(ctx.db);
  const key = `weather:${ext.location_lat.toFixed(2)},${ext.location_lon.toFixed(2)}`;
  const now = ctx.clock.now();
  const cached = await ctx.db.first<{ data_enc: string | null; fetched_at: number; status: string; source_url: string | null }>(
    "SELECT data_enc, fetched_at, status, source_url FROM info_snapshots WHERE query_key = ? AND provider = ? ORDER BY fetched_at DESC LIMIT 1",
    key,
    ctx.ext.info.name,
  );
  let report: WeatherReport;
  if (cached && cached.status === "ok" && now - cached.fetched_at < WEATHER_TTL_MS && cached.data_enc) {
    report = JSON.parse(await ctx.crypto.decrypt(cached.data_enc, "info")) as WeatherReport;
  } else {
    report = await ctx.ext.info.weather(ext.location_lat, ext.location_lon);
    await ctx.db.run(
      "INSERT INTO info_snapshots (id, provider, query_key, data_enc, source_url, fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId("inf"),
      ctx.ext.info.name,
      key,
      report.status === "ok" ? await ctx.crypto.encrypt(JSON.stringify(report), "info") : null,
      report.sourceUrl,
      report.fetchedAt,
      report.status === "ok" ? "ok" : "unavailable",
    );
  }
  if (report.status !== "ok" || report.periods.length === 0) return "Weather: unavailable right now.";
  const p = report.periods[0]!;
  const src = ctx.ext.info.name === "nws" ? "NWS" : "simulated";
  return `Weather (${ext.location_label ?? "home"}, ${src}, as of ${formatTime(report.fetchedAt, s.timezone)}): ${p.name} ${p.summary}, ${p.temperature}.`;
}

/** "I have 20 minutes free": only tasks with explicit estimates that fit, plus a parked idea. */
export async function freeTime(ctx: AppContext, minutes: number): Promise<string> {
  const fit = await contextTasks(ctx, minutes, []);
  const idea = (await listItems(ctx, "idea", { status: ["open"], limit: 1 }))[0];
  const interest = (await listItems(ctx, "interest", { status: ["open"], limit: 1 }))[0];
  const extra = [idea ? `parked idea: ${idea.title}` : null, interest ? `something you're interested in: ${interest.title}` : null].filter(Boolean);
  return `${fit}${extra.length ? ` Or: ${extra.join("; ")}.` : ""} Resting is a fine use of it too.`;
}

export async function tripBrief(ctx: AppContext, destination: string | null): Promise<string> {
  const s = await getSettings(ctx.db);
  const trips = await listItems(ctx, "trip", { status: ["open"], limit: 10 });
  const trip = destination ? trips.find((t) => t.title.toLowerCase().includes(cleanLabel(destination).toLowerCase())) : trips[0];
  const lessons = (await listItems(ctx, "lesson", { status: ["open"], limit: 20 })).filter((l) =>
    /pack|trip|travel|flight|forgot/i.test(`${l.title} ${String(l.data.activity ?? "")}`),
  );
  const parts: string[] = [];
  if (trip) {
    parts.push(`${trip.title}${trip.due_at ? ` (${formatDate(trip.due_at, s.timezone)})` : ""}.`);
    const packing = Array.isArray(trip.data.packing) ? (trip.data.packing as string[]) : [];
    if (packing.length) parts.push(`Packing you listed: ${packing.join(", ")}.`);
  } else parts.push(destination ? `No trip to ${cleanLabel(destination)} recorded.` : "No upcoming trip recorded.");
  if (lessons.length)
    parts.push(
      `Past lessons: ${lessons
        .slice(0, 2)
        .map((l) => l.title)
        .join("; ")}.`,
    );
  const w = await weatherLine(ctx);
  if (w) parts.push(destination ? `${w} (Home forecast only; I don't look up destinations.)` : w);
  return parts.join(" ");
}
