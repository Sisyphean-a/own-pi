import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { object, makeRecord, recordFromEntry, USAGE_EVENT } from "./record.ts";
import { knownModel, canonicalModel } from "./pricing.ts";
import { JournalWriter } from "./writer.ts";

type State = { ctx: ExtensionContext; writer: JournalWriter; aliases: Record<string, string>; cursor: string | null; seen: Set<string>; timer?: ReturnType<typeof setInterval>; off?: () => void; invalid: number };
export function register(pi: ExtensionAPI, dataRoot?: string): void {
  let active: State | undefined;
  let commandQueue: Promise<void> = Promise.resolve();
  const root = (): string => dataRoot ?? join(getAgentDir(), "pi-token-stats");
  const remember = (state: State, id: string): void => {
    state.seen.add(id);
    if (state.seen.size > 256) state.seen.delete(state.seen.values().next().value!);
  };
  const collect = (state: State): void => {
    const manager = state.ctx.sessionManager;
    if (typeof manager.getLeafId !== "function" || typeof manager.getEntry !== "function") return;
    try {
      const leaf = manager.getLeafId();
      let id = leaf;
      while (id && id !== state.cursor) {
        const entry = manager.getEntry(id);
        if (!entry) break;
        if (entry.type !== "message" && !state.seen.has(entry.id)) {
          remember(state, entry.id);
          const r = recordFromEntry(entry, state.aliases);
          if (r) state.writer.enqueue(r);
        }
        id = entry.parentId;
      }
      state.cursor = leaf;
    } catch { state.invalid++; }
  };
  const capture = (value: unknown): void => {
    if (!active) return;
    try { const r = makeRecord(value, active.aliases); if (r) active.writer.enqueue(r); else active.invalid++; }
    catch { active.invalid++; }
  };
  const stop = async (): Promise<void> => {
    const state = active;
    if (!state) return;
    active = undefined;
    if (state.timer) clearInterval(state.timer);
    state.off?.(); collect(state); await state.writer.close();
  };
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    let aliases: Record<string, string> = {};
    try {
      const config = object(JSON.parse(await readFile(join(root(), "aliases.json"), "utf8")));
      if (!config || Object.entries(config).some(([key, value]) => !key.trim() || key.length > 256 || typeof value !== "string" || !knownModel(value))) throw new Error("模型别名配置无效");
      aliases = config as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (ctx.hasUI && typeof ctx.ui.notify === "function") ctx.ui.notify("Token 统计未启动：模型别名配置无法读取或格式无效", "error");
        return;
      }
    }
    const state: State = { ctx, aliases, writer: new JournalWriter(root()), cursor: ctx.sessionManager.getLeafId?.() ?? null, seen: new Set(), invalid: 0 };
    active = state;
    if (typeof pi.events?.on === "function") state.off = pi.events.on(USAGE_EVENT, capture);
    if (typeof ctx.sessionManager.getLeafId === "function" && typeof ctx.sessionManager.getEntry === "function") {
      // Rule: 预热没有公开完成事件；空闲时仅 O(1) 检查水位，变化时才走新增条目。
      state.timer = setInterval(() => collect(state), 5000); state.timer.unref();
    }
  });
  pi.on("message_end", event => { if (object(event.message)?.role === "assistant") capture(event.message); });
  pi.on("agent_settled", () => { if (active) collect(active); });
  pi.on("session_before_tree", () => { if (active) collect(active); });
  pi.on("session_before_fork", () => { if (active) collect(active); });
  pi.on("session_tree", (event, ctx) => {
    if (!active) return;
    if (event.summaryEntry && !active.seen.has(event.summaryEntry.id)) {
      const record = recordFromEntry(event.summaryEntry, active.aliases);
      if (record) active.writer.enqueue(record);
      remember(active, event.summaryEntry.id);
    }
    active.cursor = ctx.sessionManager.getLeafId?.() ?? null;
  });
  pi.on("session_compact", event => {
    if (!active) return;
    const entry = event.compactionEntry;
    if (!active.seen.has(entry.id)) {
      const record = recordFromEntry(entry, active.aliases);
      if (record) active.writer.enqueue(record);
      remember(active, entry.id);
    }
    collect(active);
  });
  pi.on("session_shutdown", stop);
  pi.registerCommand("token", {
    description: "查看模型 Token、缓存、官方价估算；支持 html、import、alias、resume",
    handler: (args, ctx) => {
      const run = async (): Promise<void> => {
        const notify = (text: string, type: "info" | "error" = "info"): void => { if (ctx.hasUI && typeof ctx.ui.notify === "function") ctx.ui.notify(text, type); };
        try {
          if (!active) throw new Error("Token 统计未启动；检查别名配置后 /reload");
          collect(active); await active.writer.flush();
          const parts = args.trim().split(/\s+/).filter(Boolean), command = parts[0];
          if (command === "resume") {
            if (parts.length !== 1) throw new Error("用法：/token resume");
            await active.writer.resume(); notify("Token 统计已恢复"); return;
          }
          if (command === "alias") {
            if (parts.length !== 3 || parts[1]!.length > 256 || !knownModel(parts[2]!)) throw new Error("用法：/token alias 自定义模型名 已知官方模型名");
            const aliases = { ...active.aliases, [parts[1]!]: canonicalModel(parts[2]!) };
            await mkdir(root(), { recursive: true, mode: 0o700 });
            const path = join(root(), "aliases.json");
            await writeFile(path + ".tmp", JSON.stringify(aliases, null, 2), { mode: 0o600 }); await rename(path + ".tmp", path);
            active.aliases = aliases; notify("别名已保存；只影响后续采集/导入，已有费用不重算"); return;
          }
          if (command === "help") { notify("/token\n/token html [开始日期 结束日期]\n/token import\n/token alias 自定义名 官方模型名\n/token resume\n日期格式 YYYY-MM-DD；html 带日期时包含该范围请求明细。"); return; }
          if (command && command !== "html" && command !== "import") throw new Error("未知参数；/token help 查看用法");
          if ((command === "html" && ![1, 3].includes(parts.length)) || (command === "import" && parts.length !== 1)) throw new Error("参数不完整；/token help 查看用法");
          const { withIndex, overview, persistedWarnings, importSessions } = await import("./query.ts");
          const stateWarnings = await persistedWarnings(root());
          const status = active.writer.status();
          if (status.failure) stateWarnings.push(status.failure);
          if (status.dropped) stateWarnings.push(`本次已知丢弃 ${status.dropped} 条`);
          if (active.invalid) stateWarnings.push(`本次 ${active.invalid} 次计量无法读取`);
          const result = await withIndex(root(), async (db, warnings) => {
            if (command === "import") {
              const imported = await importSessions(db, root(), join(getAgentDir(), "sessions"), active!.aliases);
              return `历史导入：新增 ${imported.imported} 条；摘要缺用量 ${imported.missing} 条；损坏行 ${imported.malformed} 条。\n按导入时官方价估算，旧字段缺失不猜测。`;
            }
            if (command === "html") {
              const { writeReport } = await import("./report.ts");
              const file = join(root(), "token-report.html");
              await writeReport(db, file, [...new Set([...stateWarnings, ...warnings])], parts[1], parts[2]);
              return `已生成离线快照：${file}\n直接用浏览器打开；重新执行命令更新。`;
            }
            return overview(db);
          });
          const warnings = [...new Set([...stateWarnings, ...result.warnings])];
          notify(result.value + (warnings.length ? "\n\n统计异常：\n" + warnings.join("\n") : ""));
        } catch (error) { notify(`Token 统计失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
      };
      commandQueue = commandQueue.then(run, run); return commandQueue;
    },
  });
}
