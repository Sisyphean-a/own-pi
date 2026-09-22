import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createModelTranslationRequester,
  DescriptionTranslations,
  hasChineseDescription,
  parseTranslationResponse,
  type TranslationRequester,
} from "../src/panel/description-translations.ts";

const target = {
  kind: "command" as const,
  name: "resume",
  description: "Resume a previous session",
};

function response(text: string): string {
  return JSON.stringify({ translations: [{ id: "d0", text }] });
}

test("detects descriptions containing at least one Han character", () => {
  assert.equal(hasChineseDescription("Resume session"), false);
  assert.equal(hasChineseDescription("Resume 会话"), true);
});

test("accepts only the exact translation response structure", () => {
  assert.deepEqual(
    [...parseTranslationResponse(response("恢复之前的会话"), ["d0"])],
    [["d0", "恢复之前的会话"]],
  );
  assert.throws(
    () => parseTranslationResponse('```json\n{"translations":[]}\n```', ["d0"]),
    /有效 JSON/,
  );
  assert.throws(
    () => parseTranslationResponse(JSON.stringify({ translations: [{ id: "d0", text: "Resume" }] }), ["d0"]),
    /中文描述/,
  );
  assert.throws(
    () => parseTranslationResponse(JSON.stringify({ translations: [{ id: "d0", text: "恢复", note: "extra" }] }), ["d0"]),
    /只包含 id 和 text/,
  );
});

test("retries invalid model formats at most three times", async () => {
  const directory = await mkdtemp(join(tmpdir(), "description-translations-"));
  const cache = new DescriptionTranslations(join(directory, "cache.json"));
  let attempts = 0;
  const requester: TranslationRequester = async () => {
    attempts += 1;
    if (attempts === 1) return "not json";
    if (attempts === 2) return JSON.stringify({ translations: [] });
    return response("恢复之前的会话");
  };

  try {
    assert.equal(await cache.translateMissing([target], requester), 1);
    assert.equal(attempts, 3);

    const alwaysInvalid: TranslationRequester = async () => {
      attempts += 1;
      return "still invalid";
    };
    await assert.rejects(
      () => new DescriptionTranslations(join(directory, "other.json")).translateMissing([target], alwaysInvalid),
      /连续 3 次格式无效/,
    );
    assert.equal(attempts, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists translations and invalidates them when the source description changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "description-translations-"));
  const cachePath = join(directory, "cache.json");
  const cache = new DescriptionTranslations(cachePath);
  let requests = 0;
  const requester: TranslationRequester = async (_system, userPrompt) => {
    requests += 1;
    assert.doesNotMatch(userPrompt, /resume/);
    assert.match(userPrompt, /Resume a previous session/);
    return response("恢复之前的会话");
  };

  try {
    assert.equal(await cache.translateMissing([target], requester), 1);
    assert.equal(cache.resolve("command", "resume", target.description), "恢复之前的会话");
    assert.equal(cache.resolve("command", "resume", "Resume another session"), "Resume another session");
    assert.equal(await cache.translateMissing([target], requester), 0);
    assert.equal(requests, 1);

    const restored = new DescriptionTranslations(cachePath);
    await restored.load();
    assert.equal(restored.resolve("command", "resume", target.description), "恢复之前的会话");

    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as { version: number };
    assert.equal(persisted.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shares translations between source-prefixed command metadata and raw skill descriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "description-translations-"));
  const cachePath = join(directory, "cache.json");
  const cache = new DescriptionTranslations(cachePath);
  const rawDescription = "Control a real browser via CDP";
  const prefixedDescription = `[u] ${rawDescription}`;
  let requestedPrompt = "";

  try {
    assert.equal(await cache.translateMissing(
      [{ kind: "skill", name: "browser-harness", description: prefixedDescription }],
      async (_system, userPrompt) => {
        requestedPrompt = userPrompt;
        return response("通过 CDP 控制真实浏览器");
      },
    ), 1);
    assert.doesNotMatch(requestedPrompt, /\[u\]/);
    assert.equal(cache.resolve("skill", "browser-harness", rawDescription), "通过 CDP 控制真实浏览器");
    assert.equal(
      cache.resolve("skill", "browser-harness", prefixedDescription),
      "[u] 通过 CDP 控制真实浏览器",
    );
    assert.equal(await cache.translateMissing(
      [{ kind: "skill", name: "browser-harness", description: rawDescription }],
      async () => {
        throw new Error("规范描述相同，不应重复翻译");
      },
    ), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates source-prefixed version-one cache entries in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "description-translations-"));
  const cachePath = join(directory, "cache.json");
  const source = "[u:npm:context-mode] Use context-mode tools instead of Bash";
  const sourceHash = createHash("sha256").update(source).digest("hex");

  try {
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      entries: {
        [`skill:context-mode:${sourceHash}`]: {
          source,
          translated: "[u:npm:context-mode] 使用 context-mode 工具替代 Bash",
        },
      },
    }), "utf8");

    const restored = new DescriptionTranslations(cachePath);
    await restored.load();
    assert.equal(
      restored.resolve("skill", "context-mode", "Use context-mode tools instead of Bash"),
      "使用 context-mode 工具替代 Bash",
    );
    assert.equal(
      restored.resolve("skill", "context-mode", source),
      "[u:npm:context-mode] 使用 context-mode 工具替代 Bash",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses only provider-neutral options for the translation model request", async () => {
  let requestOptions: Record<string, unknown> | undefined;
  const model = { maxTokens: 8_192, thinkingLevelMap: { off: "none" } };
  const ctx = {
    model,
    modelRegistry: {
      streamSimple(_model: unknown, _context: unknown, options: Record<string, unknown>) {
        requestOptions = options;
        return {
          async *[Symbol.asyncIterator]() {},
          async result() {
            return {
              stopReason: "stop",
              content: [{ type: "text", text: response("恢复之前的会话") }],
            };
          },
        };
      },
    },
  } as never;

  const requester = createModelTranslationRequester(ctx);
  assert.ok(requester);
  assert.equal(await requester("system", "user", 512), response("恢复之前的会话"));
  assert.equal("temperature" in requestOptions!, false);
  assert.equal(requestOptions?.maxTokens, 512);
  assert.equal(requestOptions?.cacheRetention, "none");

  const onPayload = requestOptions?.onPayload as ((payload: unknown, model: unknown) => unknown) | undefined;
  assert.ok(onPayload);
  assert.deepEqual(
    onPayload({ model: "deepseek-v4.1-flash", reasoning_effort: "none", messages: [] }, model),
    { model: "deepseek-v4.1-flash", messages: [] },
  );
  assert.deepEqual(
    onPayload({ model: "deepseek-v4.1-flash", reasoning: { effort: "none" }, input: [] }, model),
    { model: "deepseek-v4.1-flash", input: [] },
  );
  assert.equal(onPayload({ model: "plain", reasoning_effort: "high" }, model), undefined);
});

test("never sends already-Chinese descriptions to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "description-translations-"));
  let called = false;
  try {
    const cache = new DescriptionTranslations(join(directory, "cache.json"));
    const count = await cache.translateMissing(
      [{ kind: "skill", name: "review", description: "Review 代码" }],
      async () => {
        called = true;
        return response("审查代码");
      },
    );
    assert.equal(count, 0);
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
