import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { day, object, recordFromEntry, validRecord, type UsageRecord } from "./record.ts";

export type Aggregate = {
  day: string; model: string; requests: number; input: number; hit: number; output: number; cost: number; unpriced: number;
  inputUnknown: number; hitUnknown: number; outputUnknown: number; cacheInput: number; cacheHit: number; unreported: number;
  historical: number; durationMs: number; timed: number;
};
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
  // Rule: 比例只累加输入三项齐全的请求；不能把部分已知计数拼成分子、分母。
  return db.prepare(`WITH usage AS (SELECT time,model,
    json_extract(data,'$.counts.input') AS ordinary,json_extract(data,'$.counts.cacheWrite') AS writes,
    json_extract(data,'$.counts.cacheRead') AS hits,json_extract(data,'$.counts.output') AS outputs,
    json_extract(data,'$.cost') AS cost,json_extract(data,'$.stopReason') AS stop,
    json_extract(data,'$.historicalEstimate') AS historical,json_extract(data,'$.durationMs') AS duration
    FROM records)
    SELECT ${dateExpr} AS day,model,COUNT(*) AS requests,
    SUM(COALESCE(ordinary,0)+COALESCE(writes,0)) AS input,COALESCE(SUM(hits),0) AS hit,COALESCE(SUM(outputs),0) AS output,
    COALESCE(SUM(cost),0) AS cost,SUM(cost IS NULL) AS unpriced,
    SUM(ordinary IS NULL OR writes IS NULL) AS inputUnknown,SUM(hits IS NULL) AS hitUnknown,SUM(outputs IS NULL) AS outputUnknown,
    COALESCE(SUM(CASE WHEN ordinary IS NOT NULL AND writes IS NOT NULL AND hits IS NOT NULL THEN ordinary+writes END),0) AS cacheInput,
    COALESCE(SUM(CASE WHEN ordinary IS NOT NULL AND writes IS NOT NULL AND hits IS NOT NULL THEN hits END),0) AS cacheHit,
    SUM(CASE WHEN stop IN ('error','aborted') AND ordinary IS NULL AND writes IS NULL AND hits IS NULL AND outputs IS NULL THEN 1 ELSE 0 END) AS unreported,
    SUM(historical=1) AS historical,COALESCE(SUM(duration),0) AS durationMs,SUM(duration IS NOT NULL) AS timed
    FROM usage GROUP BY ${daily ? 'day,' : ''}model ORDER BY ${daily ? 'day,' : ''}model`).all() as unknown as Aggregate[];
}
export function overview(db: DatabaseSync): string {
  const now = new Date(), today = day(now.getTime()), month = today.slice(0, 7);
  const summaries = aggregates(db, true);
  const tokens = (n: number): string => n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}百万` : n >= 10_000 ? `${Number((n / 10_000).toFixed(1))}万` : n.toLocaleString();
  const count = (n: number, missing: number, requests: number): string => missing === requests && n === 0 ? "未知" : `${missing ? "≥" : ""}${tokens(n)}`;
  const rate = (rows: Aggregate[]): string => {
    const input = rows.reduce((n, r) => n + r.cacheInput, 0), hit = rows.reduce((n, r) => n + r.cacheHit, 0);
    const partial = rows.some(r => r.inputUnknown || r.hitUnknown);
    return input + hit === 0 ? partial ? "未知" : "—" : `${(100 * hit / (input + hit)).toFixed(1)}%${partial ? "（仅已知输入）" : ""}`;
  };
  const sections = [["今日", (r: Aggregate) => r.day === today], ["本月", (r: Aggregate) => r.day.startsWith(month)], ["累计", (_r: Aggregate) => true]] as const;
  return sections.map(([title, select]) => {
    const map = new Map<string, Aggregate>();
    for (const r of summaries.filter(select)) {
      const total = map.get(r.model);
      if (!total) { map.set(r.model, { ...r }); continue; }
      for (const key of ["requests", "input", "hit", "output", "cost", "unpriced", "inputUnknown", "hitUnknown", "outputUnknown", "cacheInput", "cacheHit", "unreported", "historical", "durationMs", "timed"] as const) total[key] += r[key];
    }
    const rows = [...map.values()];
    const lines = rows.map(r => {
      const notes = [r.unreported ? `失败/取消未返回用量 ${r.unreported} 条（费用未知）` : "", r.unpriced > r.unreported ? `${r.unpriced - r.unreported} 条费用未知` : "", r.historical ? `${r.historical} 条历史估算` : ""].filter(Boolean);
      return `${r.model} · ${r.requests} 条\n  未命中 ${count(r.input, r.inputUnknown, r.requests)} / 命中 ${count(r.hit, r.hitUnknown, r.requests)} / 输出 ${count(r.output, r.outputUnknown, r.requests)} / 命中率 ${rate([r])} / 官方价估算 ${r.unpriced === r.requests ? "未知" : `$${r.cost.toFixed(6)}`}${notes.length ? `\n  ${notes.join("；")}` : ""}`;
    });
    return `${title}${rows.length ? ` · 整体命中率 ${rate(rows)}` : ""}\n${lines.join("\n") || "暂无数据"}`;
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
  let dropped = 0, failures = 0, unclosed = 0, pending = 0, unchecked = 0;
  for (const name of entries.filter(n => /^state-[a-f0-9-]+\.json$/.test(n))) {
    try {
      const state = JSON.parse(await readFile(join(root, name), "utf8"));
      dropped += Number(state.dropped) || 0; if (state.failure) failures++;
      if (!state.clean) {
        try { process.kill(state.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { unclosed++; if (state.pendingBytes > 0) pending++; }
          else unchecked++;
        }
      }
    } catch { warnings.push("统计状态文件损坏或无法读取"); }
  }
  if (dropped) warnings.push(`已知丢弃 ${dropped} 条；不能量化未上报或强杀丢失的请求`);
  if (failures) warnings.push(`${failures} 次统计运行发生写入失败`);
  if (unclosed) warnings.push(`${unclosed} 次历史退出未确认（${pending} 次最后状态仍有待写）；这不是请求失败数，无法据此确认尾部是否丢失`);
  if (unchecked) warnings.push(`${unchecked} 次运行无法检查进程状态`);
  return warnings;
}
export function validateRange(from?: string, to?: string): void {
  for (const value of [from, to]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error("日期格式应为有效的 YYYY-MM-DD");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
}
