import { existsSync } from "node:fs";
import path from "node:path";

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
    commands: [{ command: "vue-language-server", args: ["--stdio"] }],
    rootMarkers: ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
    fallbackToWorkspace: true,
    needsTypeScriptSdk: true,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: "typescript",
    commands: [{ command: "typescript-language-server", args: ["--stdio"] }],
    rootMarkers: NODE_ROOT_MARKERS,
    fallbackToWorkspace: true,
  },
  {
    id: "go",
    extensions: [".go"],
    languageId: "go",
    commands: [{ command: "gopls", args: [] }],
    rootMarkers: ["go.work", "go.mod"],
    fallbackToWorkspace: false,
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    languageId: "python",
    commands: [
      { command: "pyright-langserver", args: ["--stdio"] },
      { command: "basedpyright-langserver", args: ["--stdio"] },
    ],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"],
    fallbackToWorkspace: true,
  },
  {
    id: "html",
    extensions: [".html", ".htm"],
    languageId: "html",
    commands: [{ command: "vscode-html-language-server", args: ["--stdio"] }],
    rootMarkers: ["package.json", ".git"],
    fallbackToWorkspace: true,
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
  return undefined;
}

export function initializationOptions(server, root, workspaceRoot) {
  if (!server.needsTypeScriptSdk) return undefined;
  const tsdk = findTypeScriptSdk(root, workspaceRoot);
  return tsdk ? { typescript: { tsdk } } : undefined;
}

export function commandCandidates(root, workspaceRoot, command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return [command];

  const candidates = [];
  const absoluteWorkspace = path.resolve(workspaceRoot);
  let current = path.resolve(root);
  while (true) {
    const local = path.join(
      current,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${command}.cmd` : command,
    );
    if (existsSync(local)) candidates.push(local);
    if (current === absoluteWorkspace) break;
    current = path.dirname(current);
  }
  candidates.push(command);
  return [...new Set(candidates)];
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
