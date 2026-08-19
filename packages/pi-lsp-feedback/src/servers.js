import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bundledNodeServer(entrypoint, args) {
  return {
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, entrypoint), ...args],
  };
}

const NODE_ROOT_MARKERS = [
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
];

export const BUILTIN_SERVERS = [
  {
    id: "vue",
    extensions: [".vue"],
    languageId: "vue",
    commands: [bundledNodeServer("node_modules/@vue/language-server/bin/vue-language-server.js", ["--stdio"])],
    rootMarkers: ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
    fallbackToWorkspace: false,
    needsTypeScriptSdk: true,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: "typescript",
    commands: [bundledNodeServer("node_modules/typescript-language-server/lib/cli.mjs", ["--stdio"])],
    rootMarkers: NODE_ROOT_MARKERS,
    fallbackToWorkspace: false,
    needsNodeTypes: true,
  },
  {
    id: "go",
    extensions: [".go"],
    languageId: "go",
    commands: [{ command: "gopls", args: [] }],
    managedInstaller: "gopls",
    rootMarkers: ["go.work", "go.mod"],
    fallbackToWorkspace: false,
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    languageId: "python",
    commands: [
      bundledNodeServer("node_modules/pyright/langserver.index.js", ["--stdio"]),
      { command: "basedpyright-langserver", args: ["--stdio"] },
    ],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"],
    fallbackToWorkspace: false,
  },
  {
    id: "html",
    extensions: [".html", ".htm"],
    languageId: "html",
    commands: [bundledNodeServer("node_modules/vscode-langservers-extracted/bin/vscode-html-language-server", ["--stdio"])],
    rootMarkers: ["package.json", ".git"],
    fallbackToWorkspace: false,
  },
];

const SERVER_OVERRIDE_FIELDS = new Set([
  "enabled",
  "command",
  "args",
  "rootMarkers",
  "fallbackToWorkspace",
]);

export function resolveServerOverrides(overrides = {}) {
  const issues = [];
  const serverIds = new Set(BUILTIN_SERVERS.map((server) => server.id));
  for (const id of Object.keys(overrides)) {
    if (!serverIds.has(id)) issues.push(`${id}: unknown server id`);
  }

  const servers = [];
  for (const server of BUILTIN_SERVERS) {
    if (!Object.hasOwn(overrides, server.id)) {
      servers.push(server);
      continue;
    }
    const override = overrides[server.id];
    if (!isPlainObject(override)) {
      issues.push(`${server.id}: server override must be an object`);
      servers.push(server);
      continue;
    }
    if (override.enabled === false) continue;
    servers.push(applyServerOverride(server, override, issues));
  }

  return { servers, issues };
}

function applyServerOverride(server, override, issues) {
  for (const key of Object.keys(override)) {
    if (!SERVER_OVERRIDE_FIELDS.has(key)) {
      issues.push(`${server.id}: unknown field "${key}"`);
    }
  }
  if (Object.hasOwn(override, "enabled") && typeof override.enabled !== "boolean") {
    issues.push(`${server.id}: enabled must be a boolean`);
  }

  const next = { ...server };
  if (Object.hasOwn(override, "rootMarkers")) {
    if (isStringArray(override.rootMarkers)) {
      next.rootMarkers = override.rootMarkers;
    } else {
      issues.push(`${server.id}: rootMarkers must be an array of strings`);
    }
  }

  if (Object.hasOwn(override, "fallbackToWorkspace")) {
    if (typeof override.fallbackToWorkspace === "boolean") {
      next.fallbackToWorkspace = override.fallbackToWorkspace;
    } else {
      issues.push(`${server.id}: fallbackToWorkspace must be a boolean`);
    }
  }

  const hasCommand = Object.hasOwn(override, "command");
  const hasArgs = Object.hasOwn(override, "args");
  if (hasArgs && !hasCommand) {
    issues.push(`${server.id}: args only applies together with command`);
  }
  if (hasCommand) {
    if (typeof override.command !== "string") {
      issues.push(`${server.id}: command must be a string`);
    } else {
      const args = hasArgs && isStringArray(override.args) ? override.args : server.commands[0].args;
      next.commands = [{ command: override.command, args, bundled: false }];
    }
    if (hasArgs && !isStringArray(override.args)) {
      issues.push(`${server.id}: args must be an array of strings`);
    }
  }

  return next;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function serverForFile(servers, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return servers.find((server) => server.extensions.includes(extension));
}

export function findWorkspaceRoot(filePath, workspaceRoot, server) {
  const absoluteWorkspace = path.resolve(workspaceRoot);
  let current = path.dirname(path.resolve(filePath));
  if (!isWithin(absoluteWorkspace, current)) return undefined;

  while (true) {
    if (server.rootMarkers.some((marker) => existsSync(path.join(current, marker)))) {
      return current;
    }
    if (current === absoluteWorkspace) break;
    current = path.dirname(current);
  }

  return server.fallbackToWorkspace ? absoluteWorkspace : undefined;
}

export function findTypeScriptSdk(root, workspaceRoot) {
  const absoluteWorkspace = path.resolve(workspaceRoot);
  let current = path.resolve(root);
  while (true) {
    const sdk = path.join(current, "node_modules", "typescript", "lib");
    if (existsSync(sdk)) return sdk;
    if (current === absoluteWorkspace) break;
    current = path.dirname(current);
  }
  const bundledSdk = path.join(PACKAGE_ROOT, "node_modules", "typescript", "lib");
  return existsSync(bundledSdk) ? bundledSdk : undefined;
}

export function findNodeTypesRoot(filePath) {
  // TypeScript 解析 node:fs 等内置模块类型时沿文件目录向上找 @types/node。
  // 找不到说明该位置没有 Node 类型环境，缺环境下产生的 2307/7006 属噪音，应静默。
  let current = path.resolve(path.dirname(filePath));
  while (true) {
    if (existsSync(path.join(current, "node_modules", "@types", "node"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function initializationOptions(server, root, workspaceRoot) {
  if (!server.needsTypeScriptSdk) return undefined;
  const tsdk = findTypeScriptSdk(root, workspaceRoot);
  return tsdk ? { typescript: { tsdk } } : undefined;
}

export function commandCandidates(root, workspaceRoot, command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return [command];

  const candidates = [];
  if (command === "gopls") candidates.push(...goCommandCandidates(command));

  const absoluteWorkspace = path.resolve(workspaceRoot);
  let current = path.resolve(root);
  while (true) {
    const local = commandPath(path.join(current, "node_modules", ".bin"), command);
    if (existsSync(local)) candidates.push(local);
    if (current === absoluteWorkspace) break;
    current = path.dirname(current);
  }
  candidates.push(command);
  return [...new Set(candidates)];
}

function commandPath(binDirectory, command) {
  return path.join(binDirectory, process.platform === "win32" ? `${command}.cmd` : command);
}

function goCommandCandidates(command) {
  const configuredGoPaths = process.env.GOPATH?.split(path.delimiter).map((entry) => path.join(entry, "bin")) ?? [];
  const directories = [process.env.GOBIN, ...configuredGoPaths, path.join(homedir(), "go", "bin")]
    .filter((directory) => typeof directory === "string" && directory.length > 0);
  return [...new Set(directories)]
    .map((directory) => commandPath(directory, command))
    .filter(existsSync);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
