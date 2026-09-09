import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
  TUI_PROVIDER_USAGE_STATUS_ID,
  createProviderUsageController,
  fetchCodexUsage,
  fetchOpenCodeGoUsage,
  fetchProviderUsage,
  formatCodexUsage,
  formatOpenCodeGoUsage,
  formatProviderUsage,
  type CodexUsage,
  type OpenCodeGoUsage,
} from "../src/provider-usage.ts";

const ACCOUNT_ID = "account-test-123";
const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";

type StatusCall = { id: string; value: string | undefined };
type FakeContext = {
  ctx: ExtensionContext;
  invalidate(): void;
  statusCalls(): StatusCall[];
};

function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime() / 1000;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(accountId = ACCOUNT_ID): string {
  return [
    base64Url({ alg: "none", typ: "JWT" }),
    base64Url({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "signature",
  ].join(".");
}

function makeContext(options: {
  provider?: string;
  oauth?: boolean;
  apiKey?: string;
  headers?: Record<string, string | null>;
} = {}): ExtensionContext {
  const provider = options.provider ?? CODEX_PROVIDER_ID;
  return {
    model: { provider, id: "gpt-5" },
    modelRegistry: {
      isUsingOAuth: () => options.oauth ?? true,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: options.apiKey ?? (provider === CODEX_PROVIDER_ID ? accessToken() : "test-key"),
        headers: options.headers ?? {},
      }),
    },
  } as unknown as ExtensionContext;
}

function makeFakeContext(options: { provider?: string } = {}): FakeContext {
  let stale = false;
  const calls: StatusCall[] = [];
  const provider = options.provider ?? CODEX_PROVIDER_ID;
  const raw = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (id: string, value: string | undefined) => {
        calls.push({ id, value });
      },
    },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async (_model: unknown) => ({
        ok: true,
        apiKey: provider === CODEX_PROVIDER_ID ? accessToken() : "test-key",
        headers: {},
      }),
    },
    model: { provider, id: "gpt-5" },
    mode: "tui",
  } as const;
  const ctx = new Proxy(raw as unknown as ExtensionContext, {
    get(target, property) {
      if (stale) throw new Error(STALE_MESSAGE);
      return (target as unknown as Record<string | symbol, unknown>)[property];
    },
  });

  return {
    ctx,
    invalidate: () => { stale = true; },
    statusCalls: () => calls,
  };
}

function usageResponse(usedPercent = 30, weeklyUsedPercent?: number): Response {
  const rateLimit: Record<string, unknown> = {
    primary_window: { used_percent: usedPercent },
  };
  if (weeklyUsedPercent !== undefined) {
    rateLimit.secondary_window = { used_percent: weeklyUsedPercent };
  }
  return new Response(JSON.stringify({ rate_limit: rateLimit }), { status: 200 });
}

function installFetch(
  t: { after(callback: () => void): void },
  implementation: typeof fetch,
): void {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = previous;
  });
}

test("formats Codex percentages with five-hour time and weekly date resets", () => {
  const usage: CodexUsage = {
    fiveHour: {
      remainingPercent: 50,
      resetAt: localTimestamp(2026, 8, 26, 19, 23),
    },
    weekly: {
      remainingPercent: 78,
      resetAt: localTimestamp(2026, 8, 26),
    },
  };

  assert.equal(formatCodexUsage(usage), "codex [ 50%  19:23 ] [ 78%  08-26 ]");
});

test("formats OpenCode Go usage with five-hour, weekly, and monthly resets", () => {
  const usage: OpenCodeGoUsage = {
    fiveHour: {
      remainingPercent: 100,
      resetAt: localTimestamp(2026, 8, 26, 19, 23),
    },
    weekly: {
      remainingPercent: 94,
      resetAt: localTimestamp(2026, 8, 26),
    },
    monthly: {
      remainingPercent: 64,
      resetAt: localTimestamp(2026, 9, 18),
    },
  };

  assert.equal(
    formatOpenCodeGoUsage(usage),
    "opencode-go [ 100%  19:23 ] [ 94%  08-26 ] [ 64%  09-18 ]",
  );
  assert.equal(
    formatProviderUsage({ provider: OPENCODE_GO_PROVIDER_ID, usage }),
    "opencode-go [ 100%  19:23 ] [ 94%  08-26 ] [ 64%  09-18 ]",
  );
});

test("fetches OpenCode Go usage from the official API-key endpoint", async (t) => {
  const previous = globalThis.fetch;
  const fiveHourReset = new Date(localTimestamp(2026, 8, 26, 19, 23) * 1000).toISOString();
  const weeklyReset = new Date(localTimestamp(2026, 8, 26) * 1000).toISOString();
  const monthlyReset = new Date(localTimestamp(2026, 9, 18) * 1000).toISOString();
  let requestUrl = "";
  let requestRedirect: string | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestRedirect = init?.redirect;
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: fiveHourReset },
        weekly: { status: "ok", percent: 6, resetsAt: weeklyReset },
        monthly: { status: "ok", percent: 36, resetsAt: monthlyReset },
      },
    }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });

  const context = makeContext({ provider: OPENCODE_GO_PROVIDER_ID, apiKey: "go-api-key" });
  const usage = await fetchOpenCodeGoUsage(context);
  assert.equal(requestUrl, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(requestRedirect, "error");
  assert.equal(requestHeaders?.get("authorization"), "Bearer go-api-key");
  assert.deepEqual(usage, {
    fiveHour: { remainingPercent: 100, resetAt: Date.parse(fiveHourReset) / 1000 },
    weekly: { remainingPercent: 94, resetAt: Date.parse(weeklyReset) / 1000 },
    monthly: { remainingPercent: 64, resetAt: Date.parse(monthlyReset) / 1000 },
  });

  const routed = await fetchProviderUsage(context);
  assert.equal(formatProviderUsage(routed!), "opencode-go [ 100%  19:23 ] [ 94%  08-26 ] [ 64%  09-18 ]");
});

test("rejects incomplete OpenCode Go usage windows", async (t) => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    usage: {
      rolling: { percent: 10, resetsAt: "2026-08-26T19:23:00.000Z" },
      weekly: { percent: 20, resetsAt: "2026-08-26T00:00:00.000Z" },
    },
  }), { status: 200 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });

  assert.equal(await fetchOpenCodeGoUsage(makeContext({ provider: OPENCODE_GO_PROVIDER_ID })), undefined);
});

test("fetches official OAuth usage with only the required Codex identity headers", async (t) => {
  const previous = globalThis.fetch;
  let requestCount = 0;
  let requestUrl = "";
  let requestRedirect: string | undefined;
  let requestHeaders: Headers | undefined;
  let responseBody: unknown = {
    rate_limit: {
      primary_window: {
        used_percent: 50,
        reset_at: localTimestamp(2026, 8, 26, 19, 23),
      },
      secondary_window: {
        used_percent: 22,
        reset_at: localTimestamp(2026, 8, 26),
      },
    },
  };
  globalThis.fetch = (async (input, init) => {
    requestCount++;
    requestUrl = String(input);
    requestRedirect = init?.redirect;
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });

  const usage = await fetchCodexUsage(makeContext({
    headers: {
      "X-Private-Provider-Header": "must-not-leak",
      authorization: "Bearer wrong-token",
    },
  }));
  assert.equal(requestCount, 1);
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requestRedirect, "error");
  assert.equal(requestHeaders?.get("authorization"), `Bearer ${accessToken()}`);
  assert.equal(requestHeaders?.get("chatgpt-account-id"), ACCOUNT_ID);
  assert.equal(requestHeaders?.get("originator"), "pi");
  assert.equal(requestHeaders?.has("x-private-provider-header"), false);
  assert.equal(formatCodexUsage(usage!), "codex [ 50%  19:23 ] [ 78%  08-26 ]");

  const nonOAuthUsage = await fetchCodexUsage(makeContext({ oauth: false }));
  assert.equal(nonOAuthUsage, undefined);
  assert.equal(requestCount, 1);

  responseBody = { rate_limit: { primary_window: { used_percent: 30 } } };
  assert.equal(await fetchCodexUsage(makeContext()), undefined);
  responseBody = {
    rate_limit: {
      primary_window: {
        used_percent: 30,
        reset_at: localTimestamp(2026, 8, 26, 19, 23),
      },
      secondary_window: { used_percent: 10 },
    },
  };
  assert.equal(await fetchCodexUsage(makeContext()), undefined);

  responseBody = {
    rate_limit: {
      primary_window: { used_percent: 30, reset_at: Number.MAX_VALUE },
      secondary_window: {
        used_percent: 10,
        reset_at: localTimestamp(2026, 8, 26),
      },
    },
  };
  assert.equal(await fetchCodexUsage(makeContext()), undefined);
});

test("propagates an external abort to the usage request", async (t) => {
  const previous = globalThis.fetch;
  let abortObserved = false;
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      abortObserved = true;
      reject(new Error("aborted"));
    }, { once: true });
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });

  const abort = new AbortController();
  const pending = fetchCodexUsage(makeContext(), abort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();

  await assert.rejects(pending, /aborted/);
  assert.equal(abortObserved, true);
});

test("publishes the remaining Codex usage percentage in the compact footer", async (t) => {
  installFetch(t, async () => usageResponse(30));
  const fake = makeFakeContext();
  const controller = createProviderUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{ id: TUI_PROVIDER_USAGE_STATUS_ID, value: "codex [70%]" }]);
  controller.clear(fake.ctx);
});

test("publishes both five-hour and weekly Codex percentages in the compact footer", async (t) => {
  installFetch(t, async () => usageResponse(30, 45));
  const fake = makeFakeContext();
  const controller = createProviderUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{
    id: TUI_PROVIDER_USAGE_STATUS_ID,
    value: "codex [70%|55%]",
  }]);
  controller.clear(fake.ctx);
});

test("publishes all three OpenCode Go percentages in the compact footer", async (t) => {
  let requestUrl = "";
  let requestHeaders: Headers | undefined;
  installFetch(t, async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-08-26T19:23:00.000Z" },
        weekly: { status: "ok", percent: 6, resetsAt: "2026-08-26T00:00:00.000Z" },
        monthly: { status: "ok", percent: 36, resetsAt: "2026-09-18T00:00:00.000Z" },
      },
    }), { status: 200 });
  });
  const fake = makeFakeContext({ provider: OPENCODE_GO_PROVIDER_ID });
  const controller = createProviderUsageController();

  await controller.refresh(fake.ctx);

  assert.equal(requestUrl, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(requestHeaders?.get("authorization"), "Bearer test-key");
  assert.deepEqual(fake.statusCalls(), [{
    id: TUI_PROVIDER_USAGE_STATUS_ID,
    value: "opencode-go [100%|94%|64%]",
  }]);
  controller.clear(fake.ctx);
});

test("stops safely when the session context becomes stale", async (t) => {
  installFetch(t, async () => usageResponse());
  const fake = makeFakeContext();
  const controller = createProviderUsageController();

  await controller.refresh(fake.ctx);
  const callsAfterRefresh = fake.statusCalls().length;
  fake.invalidate();

  await assert.doesNotReject(() => controller.refresh(fake.ctx));
  assert.equal(fake.statusCalls().length, callsAfterRefresh);
  controller.clear(fake.ctx);
});

test("does not touch a stale context after an in-flight request", async (t) => {
  let resolveFetch!: (response: Response) => void;
  installFetch(t, () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  const fake = makeFakeContext();
  const controller = createProviderUsageController();
  const pending = controller.refresh(fake.ctx);

  await new Promise<void>((resolve) => setImmediate(resolve));
  fake.invalidate();
  controller.clear(fake.ctx);
  resolveFetch(usageResponse());

  await assert.doesNotReject(() => pending);
});

test("swallows transient network errors and permits a later refresh", async (t) => {
  let fetchCount = 0;
  installFetch(t, async () => {
    fetchCount++;
    if (fetchCount === 1) throw new Error("network down");
    return usageResponse(45);
  });
  const fake = makeFakeContext();
  const controller = createProviderUsageController();

  await assert.doesNotReject(() => controller.refresh(fake.ctx));
  await controller.refresh(fake.ctx);

  assert.equal(fetchCount, 2);
  assert.equal(fake.statusCalls().at(-1)?.value, "codex [55%]");
  controller.clear(fake.ctx);
});

test("clears the status for a non-provider model", async (t) => {
  installFetch(t, async () => usageResponse());
  const fake = makeFakeContext({ provider: "anthropic" });
  const controller = createProviderUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{ id: TUI_PROVIDER_USAGE_STATUS_ID, value: undefined }]);
  controller.clear(fake.ctx);
});
