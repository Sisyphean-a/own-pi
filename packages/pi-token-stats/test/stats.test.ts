import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeRecord, recordFromEntry, day, type UsageRecord } from "../src/record.ts";
import { JournalWriter, BUFFER_BYTES } from "../src/writer.ts";
import { withIndex, importSessions, overview, aggregates } from "../src/query.ts";
import { writeReport } from "../src/report.ts";
import { register } from "../src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishUsage as advisorUsage } from "../../pi-advisor/src/model-usage.ts";
import { publishUsage as memoryUsage } from "../../pi-observational-memory/src/agents/model-usage.ts";
import { publishUsage as translationUsage } from "../../pi-tui-enhancements/src/model-usage.ts";

const tmp = join(dirname(fileURLToPath(import.meta.url)), "../../../.tmp");
async function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  await mkdir(tmp, { recursive: true }); const root = await mkdtemp(join(tmp, "token-stats-test-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", model: "gpt-5.3-codex", provider: "custom", timestamp: Date.now(), durationMs: 50, stopReason: "stop", usage: { input: 100, cacheRead: 500, cacheWrite: 0, output: 30, totalTokens: 630, reasoning: 20 }, ...overrides };
}
const record = (overrides: Record<string, unknown> = {}): UsageRecord => makeRecord(message(overrides))!;

test("模型按官方价匹配，厂商金额不参与；缓存与推理不重复", () => {
  const a = record({ provider: "vendor-a" }), b = record({ provider: "vendor-b" });
  assert.equal(a.model, b.model); assert.equal(a.cost, b.cost); assert.equal(a.totalTokens, 630);
  assert.equal(a.cost, (100 * 1.75 + 500 * .175 + 30 * 14) / 1e6);
  assert.ok(!JSON.stringify(a).includes("vendor-a"));
  const c = record({ model: "claude-opus-4-6", usage: { input: 100, cacheRead: 500, cacheWrite: 200, cacheWrite1h: 150, output: 30 } });
  assert.equal(c.totalTokens, 830); assert.ok(Math.abs(c.cost! - (100 * 5 + 500 * .5 + 50 * 6.25 + 150 * 10 + 30 * 25) / 1e6) < 1e-12);
  assert.notEqual(record({ model: "gpt-5.4" }).model, a.model);
  assert.equal(record({ model: "claude-opus-4.6" }).model, "claude-opus-4-6");
});
test("三个独立生产者的协议不泄漏正文、费用或认证，消费者失败不影响请求", () => {
  for (const publish of [advisorUsage, memoryUsage, translationUsage]) {
    let payload: any;
    publish({ emit: (channel, value) => { assert.equal(channel, "pi:model-usage:v1"); payload = value; } }, message({ content: "PRIVATE", apiKey: "PRIVATE", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 99 } } }));
    assert.equal(payload.usage.input, 1); assert.ok(!JSON.stringify(payload).includes("PRIVATE")); assert.ok(!JSON.stringify(payload).includes("cost"));
    assert.doesNotThrow(() => publish({ emit: () => { throw new Error("optional consumer"); } }, message()));
    assert.doesNotThrow(() => publish(undefined, message()));
  }
});
test("未知、缺项、失败和长上下文不会伪装免费", () => {
  assert.equal(record({ model: "custom-model" }).cost, null);
  assert.equal(record({ model: "gpt-5.3-codex-2099-01-01" }).cost, null);
  const failed = record({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(failed.counts.input, null); assert.equal(failed.cost, null);
  assert.ok(record({ stopReason: "aborted" }).cost! > 0);
  assert.equal(record({ usage: { output: 9 } }).counts.input, null);
  assert.equal(record({ model: "gpt-5.4", usage: { input: 272001, cacheRead: 0, cacheWrite: 0, output: 0 } }).price!.rates.input, 5);
  assert.equal(record({ model: "claude-haiku-5-5", usage: { input: 100001, cacheRead: 0, cacheWrite: 0, output: 0 } }).price!.rates.input, .5);
  const summary = recordFromEntry({ type: "compaction", id: "summary-id", timestamp: new Date().toISOString(), usage: { input: 20, cacheRead: 10, cacheWrite: 0, output: 5 } })!;
  assert.equal(summary.model, "未知模型"); assert.equal(summary.startedAt, null); assert.equal(summary.durationMs, null); assert.equal(summary.cost, null);
});
test("有界缓冲包含在途批次，磁盘失败暂停、恢复新分片", async () => sandbox(async root => {
  const writer = new JournalWriter(root, undefined, 2048);
  const r = record(); let accepted = 0;
  for (let i = 0; i < 100; i++) if (writer.enqueue({ ...r, id: String(i).padStart(64, "0") })) accepted++;
  assert.ok(accepted > 0 && accepted < 100); assert.ok(writer.status().pendingBytes <= 2048);
  await writer.close(); assert.equal(writer.status().pendingBytes, 0); assert.equal(writer.status().dropped, 100 - accepted);
  const fs = await import("node:fs/promises");
  let fail = true;
  const broken = new JournalWriter(root, { ...fs, appendFile: async (...args: Parameters<typeof fs.appendFile>) => { if (fail) throw Object.assign(new Error("disk"), { code: "ENOSPC" }); return fs.appendFile(...args); } });
  broken.enqueue(r); await broken.flush(); assert.match(broken.status().failure!, /ENOSPC/); assert.equal(broken.status().pendingBytes, 0); assert.equal(broken.enqueue(r), false);
  fail = false; await broken.resume(); assert.equal(broken.enqueue(r), true); await broken.close();
  assert.equal(broken.status().failure, null); assert.ok(BUFFER_BYTES <= 256 * 1024);
}));
test("多进程分片、重复记录只计一次，费用快照不重算", async () => sandbox(async root => {
  const a = new JournalWriter(root), b = new JournalWriter(root), r = record();
  a.enqueue(r); b.enqueue(r); b.enqueue(record({ timestamp: Number(r.startedAt) + 1, provider: "another" }));
  await Promise.all([a.close(), b.close()]);
  const result = await withIndex(root, db => { const rows = aggregates(db); assert.equal(rows[0]!.requests, 2); assert.ok(overview(db).includes("累计")); return db.prepare("SELECT data FROM records WHERE id=?").get(r.id); });
  assert.equal(JSON.parse(String(result.value!.data)).cost, r.cost);
  assert.equal((await withIndex(root, db => aggregates(db)[0]!.requests)).value, 2);
}));
test("坏末行和超长损坏行不污染有效数据或无界积压", async () => sandbox(async root => {
  const w = new JournalWriter(root), r = record(); w.enqueue(r); await w.close();
  const dates = await readdir(join(root, "journal")), file = (await readdir(join(root, "journal", dates[0]!)))[0]!;
  const path = join(root, "journal", dates[0]!, file);
  await appendFile(path, "x".repeat(70000) + "\n" + JSON.stringify({ ...r, id: "f".repeat(64) }) + "\n{unfinished");
  const result = await withIndex(root, db => aggregates(db)[0]!.requests);
  assert.equal(result.value, 2); assert.ok(result.warnings.some(w => /损坏/.test(w))); assert.ok(result.warnings.some(w => /末行/.test(w)));
}));
test("历史导入与 fork 副本幂等；无正文和密钥进入日志", async () => sandbox(async root => {
  const sessions = join(root, "sessions"), store = join(root, "store"); await mkdir(sessions);
  const m = message({ timestamp: 1700000000000, content: [{ type: "text", text: "PRIVATE PROMPT SECRET KEY" }] });
  const lines = JSON.stringify({ type: "session", id: "original" }) + "\n" + JSON.stringify({ type: "message", id: "copied-id", timestamp: "2023-11-14T22:13:20Z", message: m }) + "\n";
  await writeFile(join(sessions, "original.jsonl"), lines);
  await writeFile(join(sessions, "fork.jsonl"), lines.replace('"original"', '"fork"'));
  const first = await withIndex(store, db => importSessions(db, store, sessions, {})); assert.equal(first.value.imported, 1);
  const second = await withIndex(store, db => importSessions(db, store, sessions, {})); assert.equal(second.value.imported, 0);
  const data = await withIndex(store, db => db.prepare("SELECT data FROM records").get());
  assert.ok(!String(data.value!.data).includes("PRIVATE")); assert.equal(JSON.parse(String(data.value!.data)).historicalEstimate, true);
}));
test("HTML 是可执行离线快照，用户模型名不能注入脚本", async () => sandbox(async root => {
  const w = new JournalWriter(root), r = record({ model: '</script><script>globalThis.pwned=true</script>' }); w.enqueue(r); await w.close();
  const file = join(root, "report.html"); await withIndex(root, db => writeReport(db, file, ["测试异常"], day(Date.now()), day(Date.now())));
  const html = await readFile(file, "utf8"); assert.ok(!html.includes('</script><script>globalThis.pwned'));
  assert.ok(!/src="https?:/.test(html)); assert.match(html, /connect-src 'none'/);
  const data = html.match(/id="data">([\s\S]*?)<\/script>/)![1]!; assert.equal(JSON.parse(data).details.length, 1);
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  const nodes = new Map<string, any>();
  const node = () => ({ textContent: "", value: "", children: [] as any[], append(...n: any[]) { this.children.push(...n); }, replaceChildren() { this.children = []; }, addEventListener() {}, onclick: undefined as any });
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  document.getElementById("data").textContent = data;
  vm.runInNewContext(script, { document, Intl, Date, Map, Set, Number, String });
  assert.equal(document.getElementById("summary").children.length, 1); assert.match(document.getElementById("warnings").textContent, /测试异常/);
  document.getElementById("model").value = "no-such-model"; document.getElementById("reset").onclick(); assert.equal(document.getElementById("summary").children.length, 1);
}));
test("命令与离线报表统一按万/百万显示，原始计数、费用和耗时不缩放", async () => sandbox(async root => {
  const cases = [[0, "0"], [9999, "9,999"], [10000, "1万"], [12345, "1.2万"], [999999, "100万"], [1000000, "1百万"], [3456789, "3.5百万"]] as const;
  const writer = new JournalWriter(root);
  for (const [i, [count]] of cases.entries()) writer.enqueue(record({ model: "format-" + i, usage: { input: count, cacheRead: count, cacheWrite: 0, output: count } }));
  const priced = record({ model: "claude-haiku-5-5", durationMs: 12345, usage: { input: 10000, cacheRead: 1000000, cacheWrite: 20000, output: 30000 } });
  writer.enqueue(priced);
  writer.enqueue(record({ model: "format-unknown", usage: { output: 10000 } }));
  await writer.close();
  const file = join(root, "units.html");
  const text = (await withIndex(root, async db => {
    await writeReport(db, file, [], day(Date.now()), day(Date.now()));
    return overview(db);
  })).value;
  for (const [i, [, expected]] of cases.entries()) assert.ok(text.includes(`format-${i} · 1 条\n  未命中 ${expected} / 命中 ${expected} / 输出 ${expected}`));
  const html = await readFile(file, "utf8"), data = html.match(/id="data">([\s\S]*?)<\/script>/)![1]!;
  const snapshot = JSON.parse(data);
  assert.equal(snapshot.details.find((r: UsageRecord) => r.id === priced.id).cost, priced.cost);
  assert.equal(snapshot.details.find((r: UsageRecord) => r.id === priced.id).counts.cacheRead, 1000000);
  const nodes = new Map<string, any>();
  const node = () => ({ textContent: "", value: "", children: [] as any[], append(...n: any[]) { this.children.push(...n); }, replaceChildren() { this.children = []; }, addEventListener() {} });
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  document.getElementById("data").textContent = data;
  vm.runInNewContext(html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!, { document, Intl, Date, Map, Set, Number, String });
  for (const [i, [, expected]] of cases.entries()) {
    for (const table of ["summary", "daily", "details"]) {
      const cells = document.getElementById(table).children.find((row: any) => row.children[0].textContent.includes("format-" + i)).children.map((cell: any) => cell.textContent);
      assert.equal(cells[table === "summary" ? 2 : 1], expected);
      assert.equal(cells[table === "summary" ? 3 : 2], expected);
      assert.equal(cells[table === "details" ? 4 : table === "summary" ? 4 : 3], expected);
    }
  }
  const detail = document.getElementById("details").children.find((row: any) => row.children[0].textContent.includes(priced.model)).children.map((cell: any) => cell.textContent);
  assert.equal(detail[1], "3万"); assert.equal(detail[2], "1百万"); assert.equal(detail[3], "2万"); assert.equal(detail[4], "3万");
  assert.equal(detail[5], "12,345"); assert.equal(detail[6], "$" + priced.cost!.toFixed(6));
  const unknown = document.getElementById("details").children.find((row: any) => row.children[0].textContent.includes("format-unknown")).children;
  assert.equal(unknown[1].textContent, "未知"); assert.equal(unknown[2].textContent, "未知");
}));
test("真实注册路径捕获主请求/后台/预热，退出释放订阅，不修改模型上下文", async () => sandbox(async root => {
  const handlers = new Map<string, (...args: any[]) => any>(), listeners = new Map<string, (v: unknown) => void>(), messages: string[] = [];
  let command: any, leaf: string | null = null;
  const entries = new Map<string, any>();
  const pi = { on(name: string, fn: any) { handlers.set(name, fn); }, registerCommand(name: string, value: any) { assert.equal(name, "token"); command = value; }, events: { on(name: string, fn: any) { listeners.set(name, fn); return () => listeners.delete(name); } } } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { notify: (v: string) => messages.push(v) }, sessionManager: { getLeafId: () => leaf, getEntry: (id: string) => entries.get(id) } } as unknown as ExtensionContext;
  register(pi, root); await handlers.get("session_start")!({}, ctx);
  const m = message(); await handlers.get("message_end")!({ message: m }, ctx);
  listeners.get("pi:model-usage:v1")!(message({ timestamp: Number(m.timestamp) + 1 }));
  entries.set("warm", { id: "warm", parentId: null, type: "usage", kind: "cache_warm", timestamp: new Date().toISOString(), model: "gpt-5.3-codex", usage: m.usage }); leaf = "warm";
  await handlers.get("agent_settled")!({}, ctx); await command.handler("", ctx);
  assert.ok(messages.at(-1)!.includes("3 条")); assert.ok(!handlers.has("context")); assert.ok(!handlers.has("provider_stream_event"));
  await handlers.get("session_before_tree")!({}, ctx); leaf = null; await handlers.get("session_tree")!({ newLeafId: null }, ctx);
  await handlers.get("session_shutdown")!({}, ctx); assert.equal(listeners.size, 0);
  await handlers.get("session_start")!({}, ctx); await command.handler("", ctx); assert.ok(messages.at(-1)!.includes("3 条")); await handlers.get("session_shutdown")!({}, ctx);
}));
