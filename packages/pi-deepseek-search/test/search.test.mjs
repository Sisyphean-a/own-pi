import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function setup() {
  let tool, provider;
  await extension({ registerTool(value) { tool = value; }, registerProvider(value) { provider = value; } });
  return { tool, provider };
}
const context = (key) => ({ modelRegistry: { getProviderAuth: async (id) => {
  assert.equal(id, "deepseek-search");
  return key ? { auth: { apiKey: key } } : undefined;
} } });

test("独立 provider 使用 Pi 密钥登录，不提供模型，也不回退到模型凭据", async () => {
  const { provider } = await setup();
  assert.equal(provider.id, "deepseek-search");
  assert.deepEqual(provider.getModels(), []);
  const credential = await provider.auth.apiKey.login({ prompt: async (prompt) => {
    assert.equal(prompt.type, "secret");
    return "search-key";
  } });
  assert.deepEqual(credential, { type: "api_key", key: "search-key" });
  assert.deepEqual(await provider.auth.apiKey.resolve({ credential }), { auth: { apiKey: "search-key" }, source: "stored credential" });
  assert.equal(await provider.auth.apiKey.resolve({}), undefined);
  await assert.rejects(provider.auth.apiKey.login({ prompt: async () => " " }), /密钥/);
});

test("搜索请求使用独立凭据、默认值和取消信号，返回来源及摘要", async () => {
  const signal = new AbortController().signal;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init.headers.Authorization, "Bearer secret-test");
    assert.deepEqual(JSON.parse(init.body), { query: "测试", count: 5, need_content: false, ori_question: "问题" });
    assert.equal(init.signal, signal);
    return new Response(JSON.stringify({ results: [{ title: "标题", url: "https://example.com", summary: "摘要" }] }));
  };
  const { tool } = await setup();
  const result = await tool.execute("1", { query: "测试", ori_question: "问题" }, signal, undefined, context("secret-test"));
  assert.deepEqual(JSON.parse(result.content[0].text), { results: [{ title: "标题", url: "https://example.com", summary: "摘要" }] });
  assert.ok(!JSON.stringify(result).includes("secret-test"));
});

test("缺失密钥、无效参数、空结果及 HTTP 错误均明确处理", async () => {
  const { tool } = await setup();
  await assert.rejects(tool.execute("1", { query: "x" }, undefined, undefined, context()), /\/login deepseek-search/);
  const ctx = context("secret-test");
  await assert.rejects(tool.execute("1", { query: "  " }, undefined, undefined, ctx), /query/);
  await assert.rejects(tool.execute("1", { query: "😀".repeat(129) }, undefined, undefined, ctx), /query/);
  await assert.rejects(tool.execute("1", { query: "x", count: 51 }, undefined, undefined, ctx), /count/);
  globalThis.fetch = async () => new Response('{"results":[]}');
  assert.deepEqual(JSON.parse((await tool.execute("1", { query: "x" }, undefined, undefined, ctx)).content[0].text), { results: [] });
  globalThis.fetch = async () => new Response('secret-test', { status: 401 });
  await assert.rejects(tool.execute("1", { query: "x" }, undefined, undefined, ctx), (error) => /401/.test(error.message) && !error.message.includes("secret-test"));
  globalThis.fetch = async () => new Response('{}');
  await assert.rejects(tool.execute("1", { query: "x" }, undefined, undefined, ctx), /results/);
});
