import assert from "node:assert/strict";
import test from "node:test";

import piOptimization from "../extensions/index.ts";

test("package entry exposes one default factory", () => {
  assert.equal(typeof piOptimization, "function");
});
