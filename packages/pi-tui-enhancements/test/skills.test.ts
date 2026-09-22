import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandInlineSkillDirectives, getSkills } from "../src/panel/skills.ts";

type TestSkill = {
  name: string;
  filePath: string;
};

function createPi(skills: TestSkill[]): ExtensionAPI {
  return {
    getCommands: () => skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: `${skill.name} description`,
      source: "skill",
      sourceInfo: { path: skill.filePath },
    })),
  } as unknown as ExtensionAPI;
}

test("uses translated skill descriptions without changing skill names", () => {
  const pi = createPi([{ name: "review", filePath: "/tmp/review/SKILL.md" }]);
  const skills = getSkills(pi, (_kind, _name, description) => `${description} 中文`);

  assert.equal(skills[0]?.name, "review");
  assert.equal(skills[0]?.description, "review description 中文");
});

test("expands every selected skill in editor order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quick-panel-test-"));
  const firstPath = join(directory, "first.md");
  const secondPath = join(directory, "second.md");

  try {
    await writeFile(firstPath, "---\nname: first\n---\nFirst instructions", "utf8");
    await writeFile(secondPath, "---\nname: second\n---\nSecond instructions", "utf8");

    const expanded = await expandInlineSkillDirectives(
      "Please use /skill:second/skill:first now.",
      createPi([
        { name: "first", filePath: firstPath },
        { name: "second", filePath: secondPath },
      ]),
    );

    const secondIndex = expanded.indexOf('name="second"');
    const firstIndex = expanded.indexOf('name="first"');
    assert.ok(secondIndex >= 0 && secondIndex < firstIndex);
    assert.doesNotMatch(expanded, /\/skill:(?:first|second)/);
    assert.match(expanded, /Please use\s+now\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
