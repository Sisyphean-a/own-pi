import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { day, object, recordFromEntry, validRecord, type UsageRecord } from "./record.ts";

export type Aggregate = { day: string; model: string; requests: number; input: number; hit: number; output: number; cost: number; unpriced: number; incomplete: number; historical: number; durationMs: number; timed: number };
export type IndexResult<T> = { value: T; warnings: string[] };
export async function withIndex<T>(root: string, task: (db: DatabaseSync, warnings: string[]) => Promise<T> | T): Promise<IndexResult<T>> {
  // Rule: SQLite 是命令阶段的可重建冷索引，不出现在模型采集路径或常驻内存中。
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "index.sqlite"));
  const warnings: string[] = [];
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, time INTEGER NOT NULL, model TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS record_time ON records(time);
      CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, offset INTEGER NOT NULL, bad INTEGER NOT NULL DEFAULT 0);`);
    await updateIndex(db, root, warnings);
    const value = await task(db, warnings);
    return { value, warnings };
  } finally { db.close(); }
}
function insert(db: DatabaseSync, record: UsageRecord): boolean {
  return Number(db.prepare("INSERT OR IGNORE INTO records VALUES(?,?,?,?)").run(record.id, record.startedAt ?? record.recordedAt, record.model, JSON.stringify(record)).changes) > 0;
}
async function updateIndex(db: DatabaseSync, root: string, warnings: string[]): Promise<void> {
  const journal = join(root, "journal");
  let dates: string[];
  try { dates = (await readdir(journal)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  let badTotal = 0, partial = 0;
  for (const date of dates) for (const file of (await readdir(join(journal, date))).filter(n => /^[a-f0-9-]+\.ndjson$/.test(n)).sort()) {
    const path = join(journal, date, file), name = relative(root, path);
    const size = (await stat(path)).size;
    const saved = db.prepare("SELECT offset,bad FROM files WHERE name=?").get(name) as { offset: number; bad: number } | undefined;
    let offset = saved?.offset ?? 0, bad = saved?.bad ?? 0;
    if (offset > size) { warnings.push("统计分片被截短，已按记录身份重新索引"); offset = 0; }
    if (offset < size) {
      const stream = createReadStream(path, { start: offset, end: size - 1 });
      let carry = Buffer.alloc(0), consumed = offset, skipping = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.concat([carry, chunk as Buffer]);
          let start = 0, end: number;
          while ((end = buffer.indexOf(10, start)) !== -1) {
            consumed += end - start + 1;
            if (skipping || end - start > 16_384) bad++;
            else {
              let r: unknown;
              try { r = JSON.parse(buffer.subarray(start, end).toString("utf8")); } catch { bad++; }
              if (r !== undefined) { if (validRecord(r)) insert(db, r); else bad++; }
            }
            skipping = false; start = end + 1; offset = consumed;
          }
          carry = buffer.subarray(start);
          if (carry.length > 16_384 || skipping) { consumed += carry.length; carry = Buffer.alloc(0); skipping = true; }
        }
        if (carry.length || skipping) partial++;
        db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?)").run(name, offset, bad);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    badTotal += bad;
  }
  if (badTotal) warnings.push(`${badTotal} 条损坏/不兼容记录未计入`);
  if (partial) warnings.push(`${partial} 个分片有未完成末行，未计入（可能正在写入或曾异常退出）`);
}
export function aggregates(db: DatabaseSync, daily = false): Aggregate[] {
  const dateExpr = daily ? "strftime('%Y-%m-%d',time/1000,'unixepoch','localtime')" : "''";
  return db.prepare(`SELECT ${dateExpr} AS day,model,COUNT(*) AS requests,
    COALESCE(SUM(COALESCE(json_extract(data,'$.counts.input'),0)+COALESCE(json_extract(data,'$.counts.cacheWrite'),0)),0) AS input,
    COALESCE(SUM(json_extract(data,'$.counts.cacheRead')),0) AS hit,
    COALESCE(SUM(json_extract(data,'$.counts.output')),0) AS output,
    COALESCE(SUM(json_extract(data,'$.cost')),0) AS cost,
    SUM(json_extract(data,'$.cost') IS NULL) AS unpriced,
    SUM(json_extract(data,'$.counts.input') IS NULL OR json_extract(data,'$.counts.cacheRead') IS NULL OR json_extract(data,'$.counts.cacheWrite') IS NULL OR json_extract(data,'$.counts.output') IS NULL) AS incomplete,
    SUM(json_extract(data,'$.historicalEstimate')=1) AS historical,
    COALESCE(SUM(json_extract(data,'$.durationMs')),0) AS durationMs,
    SUM(json_extract(data,'$.durationMs') IS NOT NULL) AS timed
    FROM records GROUP BY ${daily ? 'day,' : ''}model ORDER BY ${daily ? 'day,' : ''}model`).all() as unknown as Aggregate[];
}
export function overview(db: DatabaseSync): string {
  const now = new Date(), today = day(now.getTime()), month = today.slice(0, 7);
  const summaries = aggregates(db, true);
  const tokens = (n: number): string => n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}百万` : n >= 10_000 ? `${Number((n / 10_000).toFixed(1))}万` : n.toLocaleString();
  const sections = [["今日", (r: Aggregate) => r.day === today], ["本月", (r: Aggregate) => r.day.startsWith(month)], ["累计", (_r: Aggregate) => true]] as const;
  return sections.map(([title, select]) => {
    const map = new Map<string, Aggregate>();
    for (const r of summaries.filter(select)) {
      const total = map.get(r.model) ?? { day: "", model: r.model, requests: 0, input: 0, hit: 0, output: 0, cost: 0, unpriced: 0, incomplete: 0, historical: 0, durationMs: 0, timed: 0 };
      for (const key of ["requests", "input", "hit", "output", "cost", "unpriced", "incomplete", "historical", "durationMs", "timed"] as const) total[key] += r[key];
      map.set(r.model, total);
    }
    const lines = [...map.values()].map(r => `${r.model} · ${r.requests} 条\n  未命中 ${r.incomplete ? "≥" : ""}${tokens(r.input)} / 命中 ${r.incomplete ? "≥" : ""}${tokens(r.hit)} / 输出 ${r.incomplete ? "≥" : ""}${tokens(r.output)} / 官方价估算 $${r.cost.toFixed(6)}${r.unpriced ? ` + ${r.unpriced} 条费用未知` : ""}${r.historical ? ` / ${r.historical} 条历史估算` : ""}`);
    return `${title}\n${lines.join("\n") || "暂无数据"}`;
  }).join("\n\n");
}
export async function importSessions(db: DatabaseSync, root: string, directory: string, aliases: Record<string, string>): Promise<{ imported: number; missing: number; malformed: number }> {
  let imported = 0, missing = 0, malformed = 0;
  // Guarantee: 只有日志已持久化后才提交索引；失败可重试，同一请求身份不重复。
  const { JournalWriter, BUFFER_BYTES } = await import("./writer.ts");
  const writer = new JournalWriter(root);
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of lines) {
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { malformed++; continue; }
          const record = recordFromEntry(raw, aliases, true);
          if (!record) { if (["compaction", "branch_summary", "usage"].includes(String(object(raw)?.type))) missing++; continue; }
          if (db.prepare("SELECT 1 FROM records WHERE id=?").get(record.id)) continue;
          if (writer.status().pendingBytes + Buffer.byteLength(JSON.stringify(record)) + 1 > BUFFER_BYTES) await writer.flush();
          if (!writer.enqueue(record)) throw new Error(writer.status().failure ?? "导入缓冲无法写入");
          insert(db, record); imported++;
        }
      }
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    await walk(directory); await writer.close();
    if (writer.status().failure) throw new Error(writer.status().failure!);
    db.exec("COMMIT"); return { imported, missing, malformed };
  } catch (error) { await writer.close(); db.exec("ROLLBACK"); throw error; }
}
export async function persistedWarnings(root: string): Promise<string[]> {
  const warnings: string[] = [];
  let entries: string[];
  try { entries = await readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return warnings; throw e; }
  const { readFile } = await import("node:fs/promises");
  let dropped = 0, failures = 0, unclosed = 0;
  for (const name of entries.filter(n => /^state-[a-f0-9-]+\.json$/.test(n))) {
    try {
      const state = JSON.parse(await readFile(join(root, name), "utf8"));
      dropped += Number(state.dropped) || 0; if (state.failure) failures++;
      if (!state.clean) { try { process.kill(state.pid, 0); } catch { unclosed++; } }
    } catch { warnings.push("统计状态文件损坏或无法读取"); }
  }
  if (dropped) warnings.push(`已知丢弃 ${dropped} 条；不能量化未上报或强杀丢失的请求`);
  if (failures) warnings.push(`${failures} 次统计运行发生写入失败`);
  if (unclosed) warnings.push(`${unclosed} 次运行未正常标记结束，尾部可能缺失`);
  return warnings;
}
export function validateRange(from?: string, to?: string): void {
  for (const value of [from, to]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error("日期格式应为有效的 YYYY-MM-DD");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
}
