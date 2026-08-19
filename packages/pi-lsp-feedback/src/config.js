import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_SERVERS, resolveServerOverrides } from "./servers.js";

const CONFIG_PATH = path.join(".pi", "lsp-feedback.json");
const KNOWN_TOP_LEVEL_FIELDS = new Set(["servers"]);

export async function loadProjectConfiguration(cwd, trusted) {
  if (!trusted) return { servers: BUILTIN_SERVERS, issues: [] };

  const configPath = path.join(cwd, CONFIG_PATH);
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { servers: BUILTIN_SERVERS, issues: [] };
    }
    return defaultWithIssue(`${CONFIG_PATH}: ${errorMessage(error)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return defaultWithIssue(`${CONFIG_PATH}: ${errorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    return defaultWithIssue(`${CONFIG_PATH} must contain a JSON object`);
  }

  const issues = [];
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      issues.push(`${CONFIG_PATH}: unknown field "${key}"`);
    }
  }
  if (parsed.servers === undefined) return { servers: BUILTIN_SERVERS, issues };

  if (!isPlainObject(parsed.servers)) {
    issues.push(`${CONFIG_PATH}.servers must contain an object`);
    return { servers: BUILTIN_SERVERS, issues };
  }

  const resolved = resolveServerOverrides(parsed.servers);
  return {
    servers: resolved.servers,
    issues: [...issues, ...resolved.issues],
  };
}

function defaultWithIssue(issue) {
  return { servers: BUILTIN_SERVERS, issues: [issue] };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { CONFIG_PATH };
