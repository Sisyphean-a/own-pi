import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { debugLog } from "./debug-log.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; baseUrl?: string }
	| { ok: false; reason: string };

/**
 * 与 pi 自己的请求认证判定规则（`AgentSession._getRequiredRequestAuth`）一致：
 * 只要解析出的认证带有 apiKey 或至少一个 header 值，就视为可用。
 * OAuth provider（kimi-coding、xai、openai-codex、anthropic OAuth 等）通过 `toAuth()`
 * 返回 `{ headers: { Authorization: "Bearer …" } }` 且没有 apiKey 来认证，
 * pi-ai provider 接受调用方提供的 Authorization header 代替 apiKey。
 *
 * 注意：`false` 结果并不等于“未认证”——见 `resolveModel`。在请求时认证的 provider
 * （Amazon Bedrock 用 AWS_PROFILE/SSO 做 SigV4、Google Vertex 用 ADC）本来就不会
 * 暴露 apiKey 或 header，因为 pi 自己给它们的请求签名。
 */
function hasUsableAuth(auth: { apiKey?: unknown; headers?: unknown }): boolean {
	if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
	return countUsableHeaders(auth.headers) > 0;
}

/** 认证负载携带的 header 总数（仅诊断，绝不记录值）。 */
function countHeaders(headers: unknown): number {
	return headers && typeof headers === "object" ? Object.keys(headers as Record<string, unknown>).length : 0;
}

/** 携带非空字符串值的 header 数量——也就是 pi 真正可能发送的那些。 */
function countUsableHeaders(headers: unknown): number {
	if (!headers || typeof headers !== "object") return 0;
	return Object.values(headers as Record<string, unknown>).filter(
		(value) => typeof value === "string" && value.length > 0,
	).length;
}

/**
 * `recheckProviderCredential` 中可用性复检的等待上限，以及同一 provider 再次复检的冷却间隔。
 *
 * 复检不访问网络，在热身的 Bedrock/SSO 主机上实测约 1ms，但 `checkAuth` 可能阻塞在
 * provider 自己的凭据解析上，所以必须有界。冷却间隔避免未认证的主机在每次整理时都
 * 付出这份开销，同时仍能在会话内恢复带外续期的凭据（在另一个终端执行
 * `aws sso login`、`gcloud auth application-default login`）。
 */
const AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000;
const AVAILABILITY_RECHECK_REARM_MS = 60_000;

export type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

/** 阶段中文名，用于通知、状态与错误提示。 */
export const CONSOLIDATION_PHASE_LABELS: Record<ConsolidationPhase, string> = {
	observer: "观察",
	reflector: "反思",
	dropper: "精简",
};

/**
 * Pi 在会话替换或重载时会先触发 `session_shutdown`，再让旧 ctx 与 pi 失效。
 * 失效后调用 ctx 的 getter、`getContextUsage()`、`compact()` 或 pi 的任何方法都会抛出
 * stale 错误，因此后台任务必须把该错误当成"已被取代"而不是"失败"。
 */
export function isStaleSessionError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("stale after session replacement") || message.includes("ctx is stale");
}

/**
 * pi 是否明确报告该模型 provider 存在可用凭据来源。
 *
 * 当 pi 的可用性检查（`ModelRuntime.checkAuth`）为该 provider 解析到*某些东西*时，
 * `ModelRegistry.hasConfiguredAuth(model)` 为 true——API key、存储的凭据，或
 * `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / gcloud ADC 这类环境来源。它和
 * `auth.ok === true` 且认证负载为空一起，构成“pi 在请求时签名”的特征：
 *
 *   pi 有凭据来源，但故意不交给调用方任何可附加的东西。
 *
 * 在 Bedrock/SSO 主机上实测（pi 0.84.2，已导出 `AWS_PROFILE`）：
 *   checkAuth("amazon-bedrock") -> { source: "AWS_PROFILE", type: "api_key" }
 *   hasConfiguredAuth(model)    -> true
 *   getApiKeyAndHeaders(model)  -> { ok: true, apiKey: undefined, headers: undefined }
 * `googleVertexProvider` 的 ADC 分支返回同样的空认证解析。
 *
 * 反过来的情况——`hasConfiguredAuth === false` 且认证负载为空——是 pi 完全无法认证的
 * provider（没有 key，也没有环境来源）。它必须继续失败：这是普通的“未登录”状态，
 * 不是环境认证。
 *
 * 防御性：旧版 pi 和部分测试替身可能不暴露该接口，未知答案不得读作“已认证”。
 */
function hasConfiguredProviderCredential(registry: unknown, model: unknown): boolean {
	try {
		return (registry as { hasConfiguredAuth?: (m: unknown) => unknown }).hasConfiguredAuth?.(model) === true;
	} catch {
		return false;
	}
}

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	compactInFlight = false;
	compactHookInFlight = false;
	/**
	 * 会话代次：每次会话替换、重载或退出都自增。后台任务在启动时捕获代次，
	 * 代次变化后立即停止，不再触碰已失效的 ctx/pi。
	 */
	sessionEpoch = 0;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	/** provider -> 上次可用性复检的毫秒时间戳（见 `recheckProviderCredential`）。 */
	availabilityRecheckedAt = new Map<string, number>();
	/** 刻意空结果退避（#23）：同一区间内不再重复触发观察器，直到累计足够的新 token。 */
	observerEmptyBackoff: {
		sessionIdentity: string | undefined;
		coverageId: string | undefined;
		tokensAtEmpty: number;
	} | undefined;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/** 会话替换、重载或退出：作废在途后台任务，并释放会被下一个会话复用的运行标志。 */
	endSession(): void {
		this.sessionEpoch += 1;
		this.consolidationInFlight = false;
		this.consolidationPhase = undefined;
		this.consolidationPromise = null;
		this.compactInFlight = false;
		this.compactHookInFlight = false;
		this.observerEmptyBackoff = undefined;
	}

	/** 代次仍匹配时，启动该任务时的 ctx/pi 才可用。 */
	isSessionCurrent(epoch: number): boolean {
		return this.sessionEpoch === epoch;
	}

	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		let model = ctx.model;
		if (this.config.model) {
			const configured = ctx.modelRegistry.find(this.config.model.provider, this.config.model.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(
					`观察式记忆：配置的模型 ${this.config.model.provider}/${this.config.model.id} 不存在，改用当前会话模型`,
					"warning",
				);
			}
		}
		if (!model) return { ok: false, reason: "没有可用模型（当前会话没有模型，也未配置观察式记忆模型）" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		const provider = (model as { provider?: string }).provider ?? "unknown";
		const isOAuth = ctx.modelRegistry.isUsingOAuth?.(model) === true;
		// `auth.ok === false` 是唯一明确的失败：provider 需要请求认证头但没有解析到凭据时，
		// pi 会返回它。
		//
		// `auth.ok === true` 但既没有 apiKey 也没有 headers，而 pi 又*确实*报告了该 provider
		// 的凭据来源，这不算失败——这是 pi 描述“在请求时认证的 provider”的方式：Amazon
		// Bedrock 用环境 AWS 凭据签 SigV4（`bedrockAuth.resolve` 返回 `{ auth: {},
		// source: "AWS_PROFILE" }`），Google Vertex 用 ADC（同样的空解析）。pi 自己的原生
		// 流式路径也不转发 apiKey，它的提示前门禁只是
		// `hasConfiguredAuth(provider) || checkAuth(provider) !== undefined`——om 的预检
		// 不能比 pi 自己更严格。把它当成“没有认证”会让整理在模型被调用之前就中止，在这类
		// 主机上静默禁用观察式记忆——没有错误、没有开销、没有延迟。
		//
		// 三种情况刻意保持失败：OAuth provider，空解析意味着凭据不再可用、用户必须重新登录；
		// 解析到空*字符串* key 的凭据，这是配置错误而不是环境认证；以及 pi 完全没有报告
		// 凭据来源的 provider，那就是未认证。
		const usable = hasUsableAuth(auth);
		const resolvedEmptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
		let providerCredentialConfigured = hasConfiguredProviderCredential(ctx.modelRegistry, model);
		// pi 的门禁有两半，且从不单独信任快照（agent-session.js）：
		//
		//   hasConfiguredAuth(provider) || (await checkAuth(provider)) !== undefined
		//
		// `hasConfiguredAuth` 读取 `snapshot.configuredProviders`，该快照由可用性检查填充，
		// 并在检查被跳过（`refreshOnCreate: false`）、被中止或失败（其 catch 记录
		// `availabilityError` 后返回）时保持原样。启动时无法检查凭据的 provider——比如过期的
		// SSO token——因此在整个会话中都不在快照里，即使用户后来带外续期也一样。pi 能在下一
		// 轮恢复，因为它的第二半会实时复检；只读快照那一半会让整理在整个会话中失效，这与当初
		// 修复本门禁的缺陷属于同一类静默失败。
		//
		// 门面不暴露 `checkAuth`，但 `refresh({ providers })` 会执行同样的实时检查并更新快照，
		// 因此之后再读等价。只有其他一切都符合环境认证特征时才会尝试，所以普通的未认证
		// provider 仍在第一次调用就失败。
		if (auth.ok === true && !usable && !isOAuth && !resolvedEmptyApiKey && !providerCredentialConfigured) {
			providerCredentialConfigured = await this.recheckProviderCredential(ctx.modelRegistry, model, provider);
		}
		const signsAtRequestTime =
			auth.ok === true && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured;
		if (!auth.ok || (!usable && !signsAtRequestTime)) {
			const reason = isOAuth
				? `provider "${provider}" 认证失败——OAuth 凭据可能已过期；请运行 '/login ${provider}' 重新登录`
				: `provider "${provider}" 没有 API key 或认证头`;
			// 仅凭 reason 字符串无法区分 `ok: false` 与“`ok: true` 但无可携带内容”，这正是环境
			// 凭据中断无法从调试日志诊断的原因。记录决策输入——只有布尔值和计数，绝不记录值。
			debugLog("resolve.rejected", {
				provider,
				reason,
				authOk: auth.ok === true,
				hasApiKey: typeof auth.apiKey === "string" && auth.apiKey.length > 0,
				resolvedEmptyApiKey,
				headerCount: countHeaders(auth.headers),
				usableHeaderCount: countUsableHeaders(auth.headers),
				isOAuth,
				providerCredentialConfigured,
				signsAtRequestTime,
			});
			return { ok: false, reason };
		}
		if (!usable) {
			debugLog("resolve.request_time_signing", { provider, providerCredentialConfigured });
		}
		return {
			ok: true,
			model,
			apiKey: auth.apiKey as string | undefined,
			headers: auth.headers as Record<string, string> | undefined,
			env: auth.env as Record<string, string> | undefined,
			baseUrl: auth.baseUrl as string | undefined,
		};
	}

	/**
	 * 实时复检单个 provider 的凭据，然后重新读取 pi 的快照。
	 *
	 * 实现 pi 自己认证门禁的第二半，只用于唯一需要它的情况：解析结果看起来像环境认证，
	 * 但该 provider 不在（过期或从未填充的）可用性快照中。有界且限流；从不抛错。
	 */
	private async recheckProviderCredential(registry: unknown, model: unknown, provider: string): Promise<boolean> {
		const last = this.availabilityRecheckedAt.get(provider);
		const now = Date.now();
		if (last !== undefined && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
		this.availabilityRecheckedAt.set(provider, now);

		const refresh = (registry as { refresh?: (options?: unknown) => Promise<unknown> }).refresh;
		if (typeof refresh !== "function") {
			debugLog("resolve.availability_recheck", { provider, refreshed: false, reason: "registry exposes no refresh()" });
			return false;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AVAILABILITY_RECHECK_TIMEOUT_MS);
		let refreshError: string | undefined;
		let timedOut = false;
		try {
			// allowNetwork:false——凭据复检不应等待模型目录拉取。
			// providers:[provider]——把工作和快照写入限定在该 provider 上。
			//
			// 两者从 pi 0.84 起被支持；在 pi 0.81 上门面是无参数的 `refresh()`，委托给
			// `runtime.reloadConfig()`，它会重载 models.json 并运行一次完整的、允许网络的可用性
			// 检查。在那里传选项无害，但工作更宽更慢——所以下面用竞速，而不是依赖那个版本
			// 永远看不到的中止信号。
			await Promise.race([
				refresh.call(registry, { allowNetwork: false, providers: [provider], signal: controller.signal }),
				new Promise<void>((resolve) => {
					controller.signal.addEventListener("abort", () => {
						timedOut = true;
						resolve();
					});
				}),
			]);
		} catch (error) {
			refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}

		// 即使 refresh 报错或超时也重新读取：限定范围的检查可能已更新该 provider 的快照，
		// 却在别处失败。
		const recovered = hasConfiguredProviderCredential(registry, model);
		debugLog("resolve.availability_recheck", {
			provider,
			refreshed: refreshError === undefined && !timedOut,
			recovered,
			elapsedMs: Date.now() - now,
			timedOut,
			...(refreshError === undefined ? {} : { refreshError }),
		});
		return recovered;
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		const promise = this.launchTrackedTask(ctx, "记忆整理", work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		// 会话已被替换/重载时，旧 ctx 已失效：这不是需要提醒用户的失败。
		if (isStaleSessionError(error)) return message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`观察式记忆：${CONSOLIDATION_PHASE_LABELS[phase]}阶段失败：${message}`, "warning");
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		label: string,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				// 会话替换/重载导致的 stale 错误属于正常收尾，不打扰用户。
				if (!isStaleSessionError(error) && hasUI && ui) {
					ui.notify(`观察式记忆：${label} 任务失败：${errorMessage}`, "warning");
				}
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
