import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(".pi", "lsp-feedback.json");

export async function loadProjectOverrides(cwd, trusted) {
  if (!trusted) return {};
  const configPath = path.join(cwd, CONFIG_PATH);
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {};
    throw error;
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }
  if (parsed.servers === undefined) return {};
  if (!parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
    throw new Error(`${CONFIG_PATH}.servers must contain an object`);
  }
  return parsed.servers;
}

export { CONFIG_PATH };
