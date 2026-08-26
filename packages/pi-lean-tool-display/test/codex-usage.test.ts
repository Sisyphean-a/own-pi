import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER_ID, createCodexUsageController } from "../src/codex-usage.ts";

const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";

type StatusCall = { id: string; value: string | undefined };
type FakeContext = {
  ctx: ExtensionContext;
  invalidate(): void;
  statusCalls(): StatusCall[];
};

function makeFakeContext(options: { provider?: string } = {}): FakeContext {
  let stale = false;
  const calls: StatusCall[] = [];
  const raw = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (id: string, value: string | undefined) => {
        calls.push({ id, value });
      },
    },
    modelRegistry: {
      getApiKeyAndHeaders: async (_model: unknown) => ({
        ok: true,
        apiKey: "test-key",
        headers: { Authorization: "Bearer test-key" },
      }),
    },
    model: { provider: options.provider ?? CODEX_PROVIDER_ID },
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

test("publishes the remaining Codex usage percentage", async (t) => {
  installFetch(t, async () => usageResponse(30));
  const fake = makeFakeContext();
  const controller = createCodexUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{ id: "lean-codex-usage", value: "codex [70%]" }]);
  controller.clear(fake.ctx);
});

test("publishes both five-hour and weekly Codex usage percentages", async (t) => {
  installFetch(t, async () => usageResponse(30, 45));
  const fake = makeFakeContext();
  const controller = createCodexUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{
    id: "lean-codex-usage",
    value: "codex [70%|55%]",
  }]);
  controller.clear(fake.ctx);
});

test("stops safely when the session context becomes stale", async (t) => {
  installFetch(t, async () => usageResponse());
  const fake = makeFakeContext();
  const controller = createCodexUsageController();

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
  const controller = createCodexUsageController();
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
  const controller = createCodexUsageController();

  await assert.doesNotReject(() => controller.refresh(fake.ctx));
  await controller.refresh(fake.ctx);

  assert.equal(fetchCount, 2);
  assert.equal(fake.statusCalls().at(-1)?.value, "codex [55%]");
  controller.clear(fake.ctx);
});

test("clears the status for a non-Codex model", async (t) => {
  installFetch(t, async () => usageResponse());
  const fake = makeFakeContext({ provider: "anthropic" });
  const controller = createCodexUsageController();

  await controller.refresh(fake.ctx);

  assert.deepEqual(fake.statusCalls(), [{ id: "lean-codex-usage", value: undefined }]);
  controller.clear(fake.ctx);
});
