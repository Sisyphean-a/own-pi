export type Rates = { input: number; output: number; cacheRead: number | null; cacheWrite: number | null; cacheWrite1h: number | null };
export type Price = { version: string; currency: "USD"; source: string; basis: string; rates: Rates };
export const PRICE_VERSION = "2026-10-12.standard.v1";
const OPENAI = "https://developers.openai.com/api/docs/pricing/";
const CLAUDE = "https://platform.claude.com/docs/en/about-claude/pricing";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";
type Rule = { source: string; basis?: string; rates: Rates; threshold?: number; long?: Rates };
const table = new Map<string, Rule>();
function rates(input: number, cacheRead: number | null, output: number, cacheWrite: number | null = null, cacheWrite1h: number | null = null): Rates {
  return { input, cacheRead, output, cacheWrite, cacheWrite1h };
}
// Rule: 每百万 token 的官方标准价；仅显式模型匹配，不按厂商或家族前缀猜价。
for (const [model, input, cache, output] of [
  ["gpt-5.4-mini", .75, .075, 4.5], ["gpt-5.4-nano", .2, .02, 1.25],
  ["gpt-5.2", 1.75, .175, 14], ["gpt-5.2-pro", 21, null, 168],
  ["gpt-5.1", 1.25, .125, 10], ["gpt-5", 1.25, .125, 10],
  ["gpt-5-mini", .25, .025, 2], ["gpt-5-nano", .05, .005, .4], ["gpt-5-pro", 15, null, 120],
  ["gpt-4.1", 2, .5, 8], ["gpt-4.1-mini", .4, .1, 1.6], ["gpt-4.1-nano", .1, .025, .4],
  ["gpt-4o", 2.5, 1.25, 10], ["gpt-4o-2024-05-13", 5, null, 15], ["gpt-4o-mini", .15, .075, .6],
  ["gpt-4-turbo-2024-04-09", 10, null, 30], ["gpt-4-0613", 30, null, 60],
  ["gpt-3.5-turbo", .5, null, 1.5], ["gpt-3.5-turbo-0125", .5, null, 1.5],
  ["gpt-3.5-turbo-1106", 1, null, 2], ["gpt-3.5-turbo-instruct", 1.5, null, 2],
  ["gpt-5.3-codex", 1.75, .175, 14],
] as const) table.set(model, { source: OPENAI, rates: rates(input, cache, output) });
for (const [model, input, cache, output] of [
  ["gpt-5.5", 5, .5, 30], ["gpt-5.5-pro", 30, null, 180],
  ["gpt-5.4", 2.5, .25, 15], ["gpt-5.4-pro", 30, null, 180],
] as const) table.set(model, { source: OPENAI, rates: rates(input, cache, output), threshold: 272_000, long: rates(input * 2, cache === null ? null : cache * 2, output * 1.5) });
for (const [model, input, cache, output] of [
  ["gpt-6-astra", 10, 1, 50], ["gpt-6.1-sol", 2, .1, 10], ["gpt-6-luna", .1, .01, .5],
  ["gpt-6-sol", 2, .2, 10], ["gpt-5.6-sol", 4, .4, 20], ["gpt-5.6-terra", 2, .2, 12], ["gpt-5.6-luna", .2, .02, 1.2],
] as const) table.set(model, { source: OPENAI, rates: rates(input, cache, output, input * 1.25), threshold: 272_000, long: rates(input * 2, cache * 2, output * 1.5, input * 2.5) });
for (const [model, input, cache, output] of [
  ["claude-fable-5-1", 10, .25, 50], ["claude-mythos-5-1", 10, .25, 50],
  ["claude-fable-5", 10, 1, 50], ["claude-mythos-5", 10, 1, 50],
  ["claude-opus-5-5", 4, .2, 20], ["claude-opus-5", 5, .5, 25],
  ["claude-opus-4-8", 5, .5, 25], ["claude-opus-4-7", 5, .5, 25],
  ["claude-opus-4-6", 5, .5, 25], ["claude-opus-4-5", 5, .5, 25],
  ["claude-opus-4-1", 15, 1.5, 75], ["claude-opus-4", 15, 1.5, 75],
  ["claude-sonnet-5-5", 2, .1, 10], ["claude-sonnet-5", 2, .2, 10],
  ["claude-sonnet-4-6", 3, .3, 15], ["claude-sonnet-4-5", 3, .3, 15], ["claude-sonnet-4", 3, .3, 15],
  ["claude-haiku-5-5", .1, .01, .5], ["claude-haiku-4-5", 1, .1, 5], ["claude-haiku-3-5", .8, .08, 4],
] as const) table.set(model, { source: CLAUDE, rates: rates(input, cache, output, input * 1.25, input * 2), ...(model === "claude-haiku-5-5" ? { threshold: 100_000, long: rates(.5, .05, 2.5, .625, 1) } : {}) });
// Rule: 非高峰/节假日优惠不在标准估算中，显式保留峰值价依据，避免假装真实扣款。
for (const model of ["deepseek-flash", "deepseek-v4.1-flash"]) table.set(model, { source: DEEPSEEK, basis: "官方峰值价；不含非高峰/节假日优惠", rates: rates(.3, .006, 1.2) });
for (const model of ["deepseek-v4-pro", "deepseek-v4-pro-0813"]) table.set(model, { source: DEEPSEEK, basis: "官方峰值价；不含非高峰/节假日优惠", rates: rates(1.32, .044, 3.96) });

export function canonicalModel(raw: string, aliases: Record<string, string> = {}): string {
  const alias = Object.hasOwn(aliases, raw) ? aliases[raw]! : raw;
  const candidate = alias.trim().toLowerCase().replace(/^(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2");
  const leaf = candidate.split("/").at(-1)!;
  return table.has(leaf) ? leaf : alias.trim();
}
export function priceFor(model: string, inputTokens: number | null): Price | null {
  const rule = table.get(model);
  if (!rule || (rule.threshold !== undefined && inputTokens === null)) return null;
  return { version: PRICE_VERSION, currency: "USD", source: rule.source, basis: rule.basis ?? "官方 API 标准价；不含特殊服务档/工具收费", rates: rule.threshold !== undefined && inputTokens! > rule.threshold ? rule.long! : rule.rates };
}
export function knownModel(model: string): boolean { return table.has(canonicalModel(model)); }
