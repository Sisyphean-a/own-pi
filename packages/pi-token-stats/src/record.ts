import { createHash } from "node:crypto";
import { canonicalModel, priceFor, type Price } from "./pricing.ts";

export const USAGE_EVENT = "pi:model-usage:v1";
export type Counts = { input: number | null; cacheRead: number | null; cacheWrite: number | null; cacheWrite1h: number | null; output: number | null };
export type UsageRecord = {
  v: 1; id: string; model: string; startedAt: number | null; completedAt: number | null; recordedAt: number;
  durationMs: number | null; counts: Counts; totalTokens: number | null; stopReason: string | null;
  price: Price | null; cost: number | null; historicalEstimate: boolean;
};
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function makeRecord(value: unknown, aliases: Record<string, string> = {}, historical = false, entryTime?: number): UsageRecord | null {
  const message = object(value);
  if (!message) return null;
  const usage = object(message.usage);
  const rawModel = typeof message.responseModel === "string" ? message.responseModel : typeof message.model === "string" ? message.model : "未知模型";
  if (!rawModel.trim() || rawModel.length > 256) return null;
  const startedAt = number(message.timestamp);
  const recordedAt = number(entryTime) ?? Date.now();
  const durationMs = number(message.durationMs);
  const counts: Counts = {
    input: number(usage?.input), cacheRead: number(usage?.cacheRead), cacheWrite: number(usage?.cacheWrite),
    cacheWrite1h: usage?.cacheWrite1h === undefined ? 0 : number(usage.cacheWrite1h), output: number(usage?.output),
  };
  const stopReason = typeof message.stopReason === "string" ? message.stopReason.slice(0, 64) : null;
  // Rule: Pi 为失败响应初始化的全零 usage 不构成供应商明确上报零消耗的证据。
  if ((stopReason === "error" || stopReason === "aborted") && !Object.values(counts).some(n => n !== null && n > 0)) {
    for (const key of Object.keys(counts) as Array<keyof Counts>) counts[key] = null;
  }
  const inputTokens = counts.input !== null && counts.cacheRead !== null && counts.cacheWrite !== null ? counts.input + counts.cacheRead + counts.cacheWrite : null;
  const model = canonicalModel(rawModel, aliases);
  const price = priceFor(model, inputTokens);
  let cost: number | null = null;
  if (price && Object.values(counts).every(n => n !== null) && counts.cacheWrite1h! <= counts.cacheWrite!) {
    const parts: Array<[number, number | null]> = [
      [counts.input!, price.rates.input], [counts.cacheRead!, price.rates.cacheRead],
      [counts.cacheWrite! - counts.cacheWrite1h!, price.rates.cacheWrite], [counts.cacheWrite1h!, price.rates.cacheWrite1h],
      [counts.output!, price.rates.output],
    ];
    if (parts.every(([tokens, rate]) => tokens === 0 || rate !== null)) cost = parts.reduce((sum, [tokens, rate]) => sum + tokens * (rate ?? 0) / 1_000_000, 0);
  }
  const allKnown = counts.input !== null && counts.cacheRead !== null && counts.cacheWrite !== null && counts.output !== null;
  const totalTokens = allKnown ? counts.input! + counts.cacheRead! + counts.cacheWrite! + counts.output! : stopReason === "error" || stopReason === "aborted" ? null : number(usage?.totalTokens);
  return {
    v: 1, id: digest([message.provider ?? null, rawModel, message.responseId ?? null, startedAt ?? entryTime ?? null, counts, stopReason]),
    model, startedAt, completedAt: startedAt !== null && durationMs !== null ? startedAt + durationMs : null,
    recordedAt, durationMs, counts, totalTokens, stopReason, price, cost, historicalEstimate: historical,
  };
}
export function recordFromEntry(value: unknown, aliases: Record<string, string> = {}, historical = false): UsageRecord | null {
  const entry = object(value);
  if (!entry) return null;
  const entryTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined;
  if (entry.type === "message" && object(entry.message)?.role === "assistant") return makeRecord(entry.message, aliases, historical, entryTime);
  if (!["usage", "compaction", "branch_summary"].includes(String(entry.type)) || !object(entry.usage)) return null;
  const record = makeRecord({ model: entry.model, usage: entry.usage }, aliases, historical, entryTime);
  if (record) record.id = digest([entry.type, entry.id, entry.timestamp, entry.usage]);
  return record;
}
export function validRecord(value: unknown): value is UsageRecord {
  const r = object(value), counts = object(r?.counts);
  return r?.v === 1 && typeof r.id === "string" && /^[a-f0-9]{64}$/.test(r.id) && typeof r.model === "string" && r.model.length <= 256
    && number(r.recordedAt) !== null && (r.startedAt === null || number(r.startedAt) !== null)
    && (r.durationMs === null || number(r.durationMs) !== null) && !!counts
    && ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output"].every(k => counts[k] === null || number(counts[k]) !== null)
    && (r.cost === null || number(r.cost) !== null);
}
export function day(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
