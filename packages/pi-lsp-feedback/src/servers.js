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

export function mergeServerOverrides(overrides = {}) {
  return BUILTIN_SERVERS
    .filter((server) => overrides[server.id]?.enabled !== false)
    .map((server) => {
      const override = overrides[server.id];
      if (!override) return server;

      return {
        ...server,
        ...(Array.isArray(override.rootMarkers) ? { rootMarkers: override.rootMarkers } : {}),
        ...(typeof override.fallbackToWorkspace === "boolean"
          ? { fallbackToWorkspace: override.fallbackToWorkspace }
          : {}),
        ...(typeof override.command === "string"
          ? {
              commands: [
                {
                  command: override.command,
                  args: Array.isArray(override.args) ? override.args : server.commands[0].args,
                  bundled: false,
                },
              ],
            }
          : {}),
      };
    });
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
