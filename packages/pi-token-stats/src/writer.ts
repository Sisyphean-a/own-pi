import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageRecord } from "./record.ts";

export const BUFFER_BYTES = 256 * 1024;
export type WriterStatus = { pid: number; run: string; clean: boolean; dropped: number; failure: string | null; pendingBytes: number };
export class JournalWriter {
  private queue: Array<{ date: string; line: string; bytes: number }> = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private run = randomUUID();
  private closed = false;
  private paused = false;
  private dropped = 0;
  private failure: string | null = null;
  readonly root: string;
  private readonly io: { appendFile: typeof appendFile; mkdir: typeof mkdir; rename: typeof rename; writeFile: typeof writeFile };
  private readonly limit: number;
  constructor(root: string, io = { appendFile, mkdir, rename, writeFile }, limit = BUFFER_BYTES) {
    this.root = root; this.io = io; this.limit = limit;
  }
  status(): WriterStatus { return { pid: process.pid, run: this.run, clean: this.closed && this.bytes === 0, dropped: this.dropped, failure: this.failure, pendingBytes: this.bytes }; }
  enqueue(record: UsageRecord): boolean {
    if (this.closed || this.paused) { this.dropped++; return false; }
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > this.limit) { this.dropped++; return false; }
    this.bytes += bytes;
    this.queue.push({ date: new Date(record.startedAt ?? record.recordedAt).toISOString().slice(0, 10), line, bytes });
    this.schedule();
    return true;
  }
  private schedule(): void {
    if (this.timer || this.closed || this.paused || this.inFlight) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
    this.timer.unref();
  }
  private async saveStatus(): Promise<void> {
    await this.io.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, `state-${this.run}.json`);
    await this.io.writeFile(file + ".tmp", JSON.stringify(this.status()), { mode: 0o600 });
    await this.io.rename(file + ".tmp", file);
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.inFlight) { await this.inFlight; if (this.queue.length) await this.flush(); return; }
    if (!this.queue.length || this.paused) return;
    const batch = this.queue;
    this.queue = [];
    const batchBytes = batch.reduce((sum, r) => sum + r.bytes, 0);
    this.inFlight = (async () => {
      try {
        // Guarantee: 在首次数据写入前落“不完整”标记；强杀后的状态不会伪装正常结束。
        await this.saveStatus();
        const groups = new Map<string, string[]>();
        for (const r of batch) { const lines = groups.get(r.date) ?? []; lines.push(r.line); groups.set(r.date, lines); }
        for (const [date, lines] of groups) {
          const dir = join(this.root, "journal", date);
          await this.io.mkdir(dir, { recursive: true, mode: 0o700 });
          await this.io.appendFile(join(dir, `${this.run}.ndjson`), lines.join(""), { mode: 0o600 });
        }
      } catch (error) {
        this.paused = true;
        const code = (error as NodeJS.ErrnoException).code ?? "IO_ERROR";
        this.failure = `${code}：统计写入失败，已暂停；修复后 /token resume`;
        this.dropped += batch.length + this.queue.length;
        this.queue = [];
      } finally {
        this.bytes = this.paused ? 0 : this.bytes - batchBytes;
        try { await this.saveStatus(); } catch { /* Failure: 磁盘完全不可写时只保留内存状态，不写终端、不无限重试。 */ }
      }
    })();
    await this.inFlight;
    this.inFlight = undefined;
    if (this.queue.length) this.schedule();
  }
  async resume(): Promise<void> {
    await this.close();
    // Rule: 新分片避免拼接坏末行；旧运行的损失只在旧状态中累计。
    this.run = randomUUID(); this.paused = true; this.failure = null; this.closed = false; this.dropped = 0;
    try { await this.saveStatus(); this.paused = false; }
    catch (error) { this.failure = `${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}：统计恢复失败，仍暂停`; throw error; }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    if (this.queue.length) await this.flush();
    try { await this.saveStatus(); } catch { /* Failure: 已由状态报告失败，不阻断 Pi 退出。 */ }
  }
}
