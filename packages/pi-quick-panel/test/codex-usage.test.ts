import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER_ID,
  fetchCodexUsage,
  formatCodexUsage,
  type CodexUsage,
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
