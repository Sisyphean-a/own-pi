import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SKILL_PACKS_DIRECTORY = "skill-packs";
export const SKILL_PACK_MANIFEST = "skill-pack.json";

export type SkillPackScope = "global" | "project";

export type SkillPack = {
  id: string;
  name: string;
  scope: SkillPackScope;
  directory: string;
  skillPaths: string[];
  skillCount: number;
};

export type SkillPackRoots = {
  global: string;
  project: string;
};

export function getSkillPackRoots(cwd: string, agentDir: string): SkillPackRoots {
  return {
    global: join(agentDir, SKILL_PACKS_DIRECTORY),
    project: join(cwd, ".pi", SKILL_PACKS_DIRECTORY),
  };
}

async function countSkillFiles(resourcePath: string): Promise<number> {
  let resourceStat;
  try {
    resourceStat = await stat(resourcePath);
  } catch {
    return 0;
  }

  if (resourceStat.isFile()) {
    return resourcePath.endsWith(`${sep}SKILL.md`) || resourcePath === "SKILL.md" ? 1 : 0;
  }
  if (!resourceStat.isDirectory()) return 0;

  let entries;
  try {
    entries = await readdir(resourcePath, { withFileTypes: true });
  } catch {
    return 0;
  }

  // Pi treats a directory containing SKILL.md as one skill root and does not
  // recurse below it. Keep pack discovery aligned with that rule.
  if (entries.some((entry) => entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink()))) {
    return 1;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    count += await countSkillFiles(join(resourcePath, entry.name));
  }
  return count;
}

function isWithinDirectory(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function getPackSkillPaths(directory: string): Promise<string[] | null> {
  const manifestPath = join(directory, SKILL_PACK_MANIFEST);
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") return [directory];
    return null;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    return null;
  }

  const configuredPaths = manifest && typeof manifest === "object"
    ? (manifest as { skillPaths?: unknown }).skillPaths
    : undefined;
  if (!Array.isArray(configuredPaths) || configuredPaths.length === 0) return null;

  const packRoot = resolve(directory);
  const skillPaths: string[] = [];
  for (const configuredPath of configuredPaths) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") return null;
    const skillPath = resolve(directory, configuredPath);
    if (!isWithinDirectory(packRoot, skillPath) || await countSkillFiles(skillPath) === 0) return null;
    if (!skillPaths.includes(skillPath)) skillPaths.push(skillPath);
  }
  return skillPaths;
}

async function discoverRoot(scope: SkillPackScope, root: string): Promise<SkillPack[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packs: SkillPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const directory = join(root, entry.name);
    const skillPaths = await getPackSkillPaths(directory);
    if (!skillPaths) continue;

    const skillCount = (await Promise.all(skillPaths.map((skillPath) => countSkillFiles(skillPath))))
      .reduce((total, count) => total + count, 0);
    if (skillCount === 0) continue;

    packs.push({
      id: `${scope}/${entry.name}`,
      name: entry.name,
      scope,
      directory,
      skillPaths,
      skillCount,
    });
  }

  return packs.sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverSkillPacks(roots: SkillPackRoots): Promise<SkillPack[]> {
  const [globalPacks, projectPacks] = await Promise.all([
    discoverRoot("global", roots.global),
    discoverRoot("project", roots.project),
  ]);
  return [...globalPacks, ...projectPacks];
}

export function filterSkillPackIds(ids: Iterable<string>, packs: SkillPack[]): string[] {
  const knownIds = new Set(packs.map((pack) => pack.id));
  return [...new Set(ids)].filter((id) => knownIds.has(id));
}

export function getEnabledSkillPackPaths(
  packs: SkillPack[],
  enabledIds: Iterable<string>,
): string[] {
  const enabled = new Set(enabledIds);
  return packs
    .filter((pack) => enabled.has(pack.id))
    .flatMap((pack) => pack.skillPaths);
}
