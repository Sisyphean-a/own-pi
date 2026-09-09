import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const packagesRoot = join(projectRoot, "packages");
const piCommand = process.env.PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi");

function usage() {
  console.log(`用法：node install-extensions.mjs [--dry-run] [--local|--global]

  --dry-run  只显示将删除和安装的包，不执行任何命令
  --local    安装到当前项目的 .pi/settings.json（默认）
  --global   明确安装到用户设置，并清理两种设置中的项目本地旧包

脚本只会移除 settings 中解析后位于脚本目录下的本地包，不会触碰 npm、git 或其他目录来源的扩展。`);
}

function parseArgs(argv) {
  const options = { dryRun: false, local: true };
  let explicitTarget;
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--local" || arg === "--global") {
      const target = arg === "--local" ? "local" : "global";
      if (explicitTarget && explicitTarget !== target) throw new Error("--local 和 --global 不能同时使用");
      explicitTarget = target;
      options.local = target === "local";
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function readSettingsPackages(settingsPath) {
  if (!existsSync(settingsPath)) return [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${settingsPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(settings?.packages)) return [];
  return settings.packages
    .map((entry) => typeof entry === "string" ? entry : entry?.source)
    .filter((source) => typeof source === "string" && source.length > 0);
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    // A removed old package can still remain in settings. Its lexical path is
    // enough to identify the stale local entry for `pi remove`.
    return absolute;
  }
}

function isUnder(root, candidate) {
  const rootPath = canonicalPath(root);
  const candidatePath = canonicalPath(candidate);
  const rest = relative(rootPath, candidatePath);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rest));
}

function localSourcePath(source, settingsPath, scope) {
  // These prefixes are package references, not direct local filesystem paths.
  if (/^(?:npm:|git:|https?:|ssh:|git@|file:)/i.test(source)) return undefined;
  if (isAbsolute(source)) return isUnder(projectRoot, source) ? canonicalPath(source) : undefined;

  // Pi resolves project-local relative sources from the project cwd. Global
  // settings may also contain a relative source created from another cwd, so
  // check the settings directory as a conservative fallback as well.
  const bases = scope === "local" ? [projectRoot] : [dirname(settingsPath), projectRoot];
  for (const base of bases) {
    const candidate = resolve(base, source);
    if (isUnder(projectRoot, candidate)) return canonicalPath(candidate);
  }
  return undefined;
}

function collectInstalledLocalPackages(includeGlobal) {
  const configDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  const settings = [
    ...(includeGlobal ? [{ path: join(configDir, "settings.json"), scope: "global" }] : []),
    { path: join(projectRoot, ".pi", "settings.json"), scope: "local" },
  ];
  const entries = [];
  for (const setting of settings) {
    for (const source of readSettingsPackages(setting.path)) {
      const path = localSourcePath(source, setting.path, setting.scope);
      if (path) entries.push({ source, path, scope: setting.scope });
    }
  }
  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.path}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort((left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path));
}

function discoverPackages() {
  if (!existsSync(packagesRoot)) throw new Error(`找不到包目录：${packagesRoot}`);
  const packages = [];
  for (const name of readDirectoryNames(packagesRoot)) {
    const packageDir = join(packagesRoot, name);
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`无法解析 ${manifestPath}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) continue;
    packages.push({ name: manifest.name || name, path: canonicalPath(packageDir) });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function readDirectoryNames(directory) {
  // Keep discovery limited to direct package children; nested package resources
  // are handled by each package's own pi manifest.
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function quoteArg(value) {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function runPi(args, dryRun) {
  console.log(`$ ${piCommand} ${args.map(quoteArg).join(" ")}`);
  if (dryRun) return;
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : piCommand;
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", piCommand, ...args]
    : args;
  // Windows exposes the npm-installed Pi launcher as a .cmd shim, which
  // requires cmd.exe when shell execution is disabled for the child process.
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令失败，退出码：${result.status ?? "unknown"}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const installed = collectInstalledLocalPackages(!options.local);
  const packages = discoverPackages();
  if (packages.length === 0) throw new Error(`脚本目录下没有发现带 pi.extensions 的包：${packagesRoot}`);

  console.log(`项目目录：${projectRoot}`);
  console.log(`发现 ${packages.length} 个扩展包：${packages.map((pkg) => pkg.name).join(", ")}`);
  console.log(`将移除 ${installed.length} 个来自项目目录的已安装本地包。`);

  for (const entry of installed) {
    const args = ["remove", entry.path];
    if (entry.scope === "local") args.push("--local");
    args.push("--approve");
    runPi(args, options.dryRun);
  }

  for (const pkg of packages) {
    const args = ["install", pkg.path];
    if (options.local) args.push("--local");
    args.push("--approve");
    runPi(args, options.dryRun);
  }

  console.log(options.dryRun ? "预览完成，未执行任何安装或删除。" : "当前目录下的所有 Pi 扩展已重新安装。");
}

try {
  main();
} catch (error) {
  console.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
