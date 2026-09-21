import assert from "node:assert/strict";
import test from "node:test";

import { createFeatureLoader } from "../src/optional-feature.ts";

test("skips a feature whose module import fails and keeps other features loading", async () => {
  const failures: string[] = [];
  const loader = createFeatureLoader((name) => failures.push(name));

  const broken = await loader.import("坏模块", async () => {
    throw new Error("boom");
  });
  const healthy = await loader.import("好模块", async () => ({ default: () => {} }));

  assert.equal(broken, undefined);
  assert.deepEqual(Object.keys(healthy!), ["default"]);
  assert.deepEqual(failures, ["坏模块"]);
});

test("activate reports a missing entry and a failing factory without throwing", async () => {
  const failures: string[] = [];
  const loader = createFeatureLoader((name) => failures.push(name));

  const missing = await loader.activate("缺少入口", async () => ({}), {} as never);
  const throwing = await loader.activate("工厂抛错", async () => ({
    default: () => {
      throw new Error("factory failed");
    },
  }), {} as never);

  assert.equal(missing, false);
  assert.equal(throwing, false);
  assert.deepEqual(failures, ["缺少入口", "工厂抛错"]);
});

test("activate passes pi through and reports success once", async () => {
  const failures: string[] = [];
  const loader = createFeatureLoader((name) => failures.push(name));
  const received: unknown[] = [];

  const activated = await loader.activate("正常功能", async () => ({
    default: (pi: { marker: string }) => {
      received.push(pi);
    },
  }), { marker: "pi" });

  assert.equal(activated, true);
  assert.deepEqual(received, [{ marker: "pi" }]);
  assert.deepEqual(failures, []);
});
