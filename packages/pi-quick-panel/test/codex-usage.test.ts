import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
  fetchCodexUsage,
  fetchOpenCodeGoUsage,
  fetchProviderUsage,
  formatCodexUsage,
  formatOpenCodeGoUsage,
  formatProviderUsage,
  type CodexUsage,
  type OpenCodeGoUsage,
} from "../src/codex-usage.ts";

const ACCOUNT_ID = "account-test-123";

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
        apiKey: options.apiKey ?? accessToken(),
        headers: options.headers ?? {},
      }),
    },
  } as unknown as ExtensionContext;
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
        rolling: {
          status: "ok",
          percent: 0,
          resetsAt: fiveHourReset,
        },
        weekly: {
          status: "ok",
          percent: 6,
          resetsAt: weeklyReset,
        },
        monthly: {
          status: "ok",
          percent: 36,
          resetsAt: monthlyReset,
        },
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
