import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Skill } from "./types.ts";

const inlineSkillDirective = /\/skill:([a-z0-9-]+)/g;

type SkillDirective = {
  start: number;
  end: number;
  skill: Skill;
};

export function getSkills(pi: ExtensionAPI): Skill[] {
  return pi.getCommands()
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => ({
      name: command.name.slice("skill:".length),
      description: command.description ?? "未提供描述",
      filePath: command.sourceInfo.path,
      baseDir: dirname(command.sourceInfo.path),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;

  const endIndex = normalized.indexOf("\n---", 3);
  return endIndex === -1 ? normalized : normalized.slice(endIndex + 4).trim();
}

function createSkillBlock(skill: Skill, content: string): string {
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export function createSkillDirective(skill: Skill): string {
  return `/skill:${skill.name}`;
}

function findInlineSkillDirectives(text: string, skillsByName: Map<string, Skill>): SkillDirective[] {
  const directives: SkillDirective[] = [];

  for (const match of text.matchAll(inlineSkillDirective)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;

    const skill = skillsByName.get(name);
    if (!skill) continue;

    directives.push({
      start: match.index,
      end: match.index + match[0].length,
      skill,
    });
  }

  return directives;
}

export async function expandInlineSkillDirectives(text: string, pi: ExtensionAPI): Promise<string> {
  const skillsByName = new Map(getSkills(pi).map((skill) => [skill.name, skill]));
  const directives = findInlineSkillDirectives(text, skillsByName);
  if (directives.length === 0) return text;

  const skillBlocks = await Promise.all(directives.map(async ({ skill }) => {
    const content = await readFile(skill.filePath, "utf8");
    return createSkillBlock(skill, content);
  }));

  const messageParts: string[] = [];
  let previousEnd = 0;
  for (const directive of directives) {
    messageParts.push(text.slice(previousEnd, directive.start));
    previousEnd = directive.end;
  }
  messageParts.push(text.slice(previousEnd));

  const userMessage = messageParts.join("").trim();
  const skills = skillBlocks.join("\n\n");
  return userMessage ? `${skills}\n\n${userMessage}` : skills;
}
