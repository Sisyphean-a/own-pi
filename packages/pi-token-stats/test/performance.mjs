import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeRecord } from "../src/record.ts";
import { JournalWriter, BUFFER_BYTES } from "../src/writer.ts";
const base = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
await mkdir(base, { recursive: true });
const root = await mkdtemp(base + "token-benchmark-");
const writer = new JournalWriter(root);
try {
  const count = 50000, samples = new Float64Array(count);
  const message = { role: "assistant", model: "gpt-5.3-codex", provider: "example", timestamp: Date.now(), durationMs: 100, stopReason: "stop", usage: { input: 500, cacheRead: 10000, cacheWrite: 0, output: 200 } };
  for (let i = 0; i < 1000; i++) makeRecord(message);
  global.gc?.(); const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < count; i++) {
    message.timestamp++; const start = performance.now();
    writer.enqueue(makeRecord(message)); samples[i] = (performance.now() - start) * 1000;
  }
  global.gc?.(); const after = process.memoryUsage().heapUsed;
  samples.sort();
  if (writer.status().pendingBytes > BUFFER_BYTES) throw new Error("缓冲超过上限");
  console.log(JSON.stringify({ requests: count, collectionMedianUs: +samples[count / 2].toFixed(2), collectionP95Us: +samples[Math.floor(count * .95)].toFixed(2), retainedHeapDeltaKiB: +((after - before) / 1024).toFixed(1), pendingBytes: writer.status().pendingBytes, overloadDropped: writer.status().dropped, note: "合成突发，只测采集/入队；不代表生产端到端性能。常驻状态不持有历史。" }));
  await writer.close();
} finally { await writer.close(); await rm(root, { recursive: true, force: true }); }
