import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverSkillPacks,
  filterSkillPackIds,
  getEnabledSkillPackPaths,
  type SkillPackRoots,
} from "../src/panel/skill-pack-discovery.ts";

async function createSkill(directory: string, name: string): Promise<void> {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, "SKILL.md"), `---\nname: ${name}\n---\n${name}`, "utf8");
}

test("discovers optional skills as global and project packs", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-pack-discovery-"));
  const roots: SkillPackRoots = {
    global: join(root, "global", "skill-packs"),
    project: join(root, "project", ".pi", "skill-packs"),
  };

  try {
    await createSkill(join(roots.global, "research"), "one");
    await createSkill(join(roots.global, "research"), "two");
    await mkdir(join(roots.global, "router", "skills"), { recursive: true });
    await writeFile(join(roots.global, "router", "skills", "SKILL.md"), "---\nname: router\n---\nrouter", "utf8");
    await createSkill(join(roots.global, "router", "skills"), "specialist");
    await writeFile(
      join(roots.global, "router", "skill-pack.json"),
      JSON.stringify({ skillPaths: ["skills"] }),
      "utf8",
    );
    await createSkill(join(roots.project, "frontend"), "vue");
    await mkdir(join(roots.global, "empty"), { recursive: true });

    const packs = await discoverSkillPacks(roots);

    assert.deepEqual(
      packs.map((pack) => [pack.id, pack.skillCount]),
      [["global/research", 2], ["global/router", 1], ["project/frontend", 1]],
    );
    assert.deepEqual(
      packs.find((pack) => pack.id === "global/router")?.skillPaths,
      [join(roots.global, "router", "skills")],
    );
    assert.deepEqual(
      getEnabledSkillPackPaths(packs, ["project/frontend"]),
      [join(roots.project, "frontend")],
    );
    assert.deepEqual(filterSkillPackIds(["global/research", "missing"], packs), ["global/research"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not allow a manifest to expose paths outside its pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-pack-manifest-"));
  const roots: SkillPackRoots = {
    global: join(root, "global"),
    project: join(root, "project"),
  };

  try {
    const pack = join(roots.global, "unsafe");
    await createSkill(pack, "local");
    await writeFile(join(pack, "skill-pack.json"), JSON.stringify({ skillPaths: ["../outside"] }), "utf8");

    assert.deepEqual(await discoverSkillPacks(roots), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing pack roots are treated as empty", async () => {
  const packs = await discoverSkillPacks({
    global: join(tmpdir(), "missing-global-skill-packs"),
    project: join(tmpdir(), "missing-project-skill-packs"),
  });
  assert.deepEqual(packs, []);
});
