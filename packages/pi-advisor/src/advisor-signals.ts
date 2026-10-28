/** 工具摘要、有限原始证据和阶段判断；不依赖 Pi 运行时。 */

export type AdvisorStage = "initial" | "recovery" | "final-check";

export interface AdvisorStageInfo {
	stage: AdvisorStage;
	reason: string;
}

export interface RunToolEvent {
	toolName: string;
	summary: string;
	command?: string;
	isError: boolean;
	timestamp: number;
	toolCallId?: string;
	evidence?: string;
}

export type ExecutorSignals = {
	phase: "exploring" | "mutating" | "verifying" | "stuck";
	mutationsCount: number;
	verificationCommands: string[];
	recentFailures: string[];
};

/** 只使用当前调用方已收到的工具结果，不额外读取文件。 */
export type ToolResultLike = {
	toolName: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
	content?: unknown;
	isError: boolean;
	details?: unknown;
};

function squeezeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function extractPrimaryText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function extractBashExitCode(text: string): number | undefined {
	// Pi 的 Bash 失败结果带有退出码文本。
	const match = text.match(/exit(?:ed)?\s+(?:with\s+)?code:?\s*(\d+)/i);
	if (!match) return undefined;
	const code = Number.parseInt(match[1], 10);
	return Number.isNaN(code) ? undefined : code;
}

export function countPatchChanges(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export const TOOL_EVIDENCE_WINDOW = 16;
const MAX_EVIDENCE_EXCERPT_CHARS = 1600;
const MAX_EVIDENCE_ITEMS = 6;
const MAX_EVIDENCE_CHARS = 12000;

export function captureToolEvidence(event: ToolResultLike): string {
	const patch = (event.details as { patch?: unknown } | undefined)?.patch;
	const text = event.toolName === "edit" && typeof patch === "string"
		? patch
		: event.toolName === "write" && typeof event.input?.content === "string"
			? event.input.content
			: extractPrimaryText(event.content);
	if (text.length <= MAX_EVIDENCE_EXCERPT_CHARS) return text;
	// Rule: 同时保留源码/日志首尾，明确暴露中间缺口，不把截断当作完整证据。
	const marker = "\n[tool evidence truncated: middle omitted]\n";
	const half = Math.floor((MAX_EVIDENCE_EXCERPT_CHARS - marker.length) / 2);
	return text.slice(0, half) + marker + text.slice(-half);
}

export function buildToolEvidence(events: RunToolEvent[]): string {
	const recent = events.slice(-TOOL_EVIDENCE_WINDOW).filter((event) => event.evidence).reverse();
	const selected = new Set<RunToolEvent>();
	// Rule: 先保留最近失败、验证、修改、读取，再用最新结果补足，避免只采纳执行者观点。
	for (const predicate of [
		(event: RunToolEvent) => event.isError,
		(event: RunToolEvent) => isVerificationCommand(event.command),
		(event: RunToolEvent) => event.toolName === "edit" || event.toolName === "write",
		(event: RunToolEvent) => event.toolName === "read",
	]) {
		const event = recent.find(predicate);
		if (event) selected.add(event);
	}
	for (const event of recent) {
		if (selected.size >= MAX_EVIDENCE_ITEMS) break;
		selected.add(event);
	}
	const blocks: string[] = [];
	let chars = 0;
	for (const event of selected) {
		const block = JSON.stringify({
			toolCallId: event.toolCallId?.slice(0, 100),
			timestamp: event.timestamp,
			isError: event.isError,
			source: event.summary.slice(0, 300),
			excerpt: event.evidence,
		});
		if (chars + block.length + 1 > MAX_EVIDENCE_CHARS - 150) continue;
		blocks.push(block);
		chars += block.length + 1;
	}
	return `Tool evidence: ${blocks.length} excerpts from the latest ${TOOL_EVIDENCE_WINDOW} tool events; ${recent.length - blocks.length} available excerpts omitted. Older evidence may be missing.\n${blocks.join("\n") || "No raw tool evidence captured."}`;
}

export function summarizeToolResult(event: ToolResultLike): RunToolEvent {
	const { toolName, input, content, isError } = event;
	const text = extractPrimaryText(content);
	const oneLine = squeezeWhitespace(text).slice(0, 140);

	switch (toolName) {
		case "read": {
			const path = typeof input?.path === "string" ? input.path : "(unknown path)";
			const offset = typeof input?.offset === "number" ? ` offset=${input.offset}` : "";
			const limit = typeof input?.limit === "number" ? ` limit=${input.limit}` : "";
			return { toolName, summary: `read ${path}${offset}${limit}`, isError, timestamp: Date.now() };
		}
		case "edit":
		case "write": {
			const path = typeof input?.path === "string" ? input.path : "(unknown path)";
			const patch = (event.details as { patch?: unknown } | undefined)?.patch;
			let changeStats = "";
			if (typeof patch === "string" && patch.length > 0) {
				const { added, removed } = countPatchChanges(patch);
				changeStats = ` (+${added}/-${removed})`;
			}
			return { toolName, summary: `${toolName} ${path}${changeStats}`, isError, timestamp: Date.now() };
		}
		case "bash": {
			const command = typeof input?.command === "string" ? squeezeWhitespace(input.command).slice(0, 140) : undefined;
			const exitCode = extractBashExitCode(text);
			const suffix = exitCode !== undefined ? ` (exit ${exitCode})` : isError ? " (error)" : "";
			return {
				toolName,
				summary: `$ ${command ?? "(unknown command)"}${suffix}`,
				command,
				isError: isError || (exitCode !== undefined && exitCode !== 0),
				timestamp: Date.now(),
			};
		}
		default:
			return {
				toolName,
				summary: oneLine ? `${toolName}: ${oneLine}` : toolName,
				isError,
				timestamp: Date.now(),
			};
	}
}

const VERIFICATION_SEGMENT_PATTERNS: RegExp[] = [
	/^(?:npx\s+|bunx\s+)?(?:jest|vitest|pytest|rspec|tsc|eslint|biome|mocha|ava)\b/,
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|build)\b/,
	/^cargo\s+(?:test|check|clippy|build)\b/,
	/^go\s+(?:test|vet|build)\b/,
	/^make\s+(?:test|check|lint|build)\b/,
	/^node\s+--test\b/,
	/^python3?\s+-m\s+pytest\b/,
];

export function isVerificationCommand(command?: string): boolean {
	if (!command) return false;
	// 只匹配管道段的命令开头，避免把读取测试文件误判为验证。
	return command.split(/&&|\|\||;|\|/).some((segment) => {
		const normalized = segment.trim().replace(/^(?:\w+=\S+\s+)+/, "");
		return VERIFICATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
	});
}

export function detectStage(events: RunToolEvent[], callNumber: number): AdvisorStageInfo {
	const hasMutation = events.some((event) => event.toolName === "edit" || event.toolName === "write");
	const hasVerification = events.some((event) => event.toolName === "bash" && isVerificationCommand(event.command));
	const recentFailure = [...events].reverse().find((event) => event.isError);
	const explorationCount = events.filter((event) => event.toolName === "read" || event.toolName === "bash").length;

	if (hasMutation && hasVerification) {
		return {
			stage: "final-check",
			reason: "Implementation changes exist and verification output is already in the transcript.",
		};
	}

	if (recentFailure) {
		return {
			stage: "recovery",
			reason: `Recent failure signal: ${recentFailure.summary}`,
		};
	}

	if (hasMutation && callNumber > 1) {
		return {
			stage: "recovery",
			reason: "Implementation has started and the executor is checking course again before finishing.",
		};
	}

	if (!hasMutation && explorationCount >= 2) {
		return {
			stage: "initial",
			reason: "Exploratory reads or commands have happened, but the executor has not committed to file changes yet.",
		};
	}

	if (hasMutation) {
		return {
			stage: "recovery",
			reason: "Implementation is in progress, but there is not enough verification evidence yet for a final check.",
		};
	}

	return {
		stage: "initial",
		reason: "The executor is still in the early orientation phase.",
	};
}

export function buildExecutorSignals(events: RunToolEvent[]): ExecutorSignals {
	const mutationsCount = events.filter((e) => e.toolName === "edit" || e.toolName === "write").length;
	const verificationCommands = events
		.filter((e): e is RunToolEvent & { command: string } => e.toolName === "bash" && isVerificationCommand(e.command))
		.map((e) => e.command);
	const recentFailures = events
		.filter((e) => e.isError)
		.slice(-3)
		.map((e) => e.summary);

	let phase: ExecutorSignals["phase"] = "exploring";
	if (mutationsCount > 0 && verificationCommands.length > 0) {
		phase = "verifying";
	} else if (mutationsCount > 0) {
		phase = "mutating";
	} else if (recentFailures.length > 0) {
		phase = "stuck";
	}

	return { phase, mutationsCount, verificationCommands, recentFailures };
}
