import { spawn } from "node:child_process";
import { diagnosticLog } from "./debug-log.js";

export interface ClipboardCommand {
	command: string;
	args: string[];
}

export type ClipboardCommandRunner = (command: ClipboardCommand, text: string) => Promise<boolean>;

export function getClipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "pbcopy", args: [] }];
		case "win32":
			return [{ command: "clip", args: [] }];
		default:
			return [
				{ command: "wl-copy", args: [] },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
				{ command: "termux-clipboard-set", args: [] },
			];
	}
}

export async function copyTextToClipboard(
	text: string,
	runner: ClipboardCommandRunner = runClipboardCommand,
	commands: ClipboardCommand[] = getClipboardCommands(),
): Promise<boolean> {
	for (const command of commands) {
		if (await runner(command, text)) return true;
	}
	return false;
}

export function runClipboardCommand(command: ClipboardCommand, text: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (ok: boolean, evidence: Record<string, unknown> = {}) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (!ok) diagnosticLog("clipboard.failed", { command: command.command, ...evidence });
			resolve(ok);
		};

		const child = spawn(command.command, command.args, {
			stdio: ["pipe", "ignore", "ignore"],
		});

		timeout = setTimeout(() => {
			child.kill();
			finish(false, { reason: "timeout", timeoutMs: 2_000 });
		}, 2_000);

		child.on("error", (error: NodeJS.ErrnoException) => finish(false, { reason: "spawn_error", code: error.code }));
		child.on("close", (code, signal) => finish(code === 0, { reason: "exit", code, signal }));
		child.stdin.on("error", (error: NodeJS.ErrnoException) => { diagnosticLog("clipboard.stdin_error", { command: command.command, code: error.code }); });
		child.stdin.end(text, "utf8");
	});
}
