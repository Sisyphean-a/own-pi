import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const packagesRoot = join(projectRoot, "packages");
const defaultOutput = join(projectRoot, "dist", "own-pi-extensions.zip");
const targets = [
  "pi-optimization",
  "pi-observational-memory",
  "pi-tui-enhancements",
];

function usage() {
  console.log(`用法：node pack-extensions.mjs [--output <zip路径>]

只打包以下扩展：
  ${targets.join("\n  ")}

默认输出：${relative(projectRoot, defaultOutput)}
压缩包顶层就是三个扩展目录，可直接解压到 ~/.pi/agent/extensions/。`);
}

function parseArgs(argv) {
  let output = defaultOutput;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true, output };
    if (arg === "--output" || arg === "-o") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} 缺少 ZIP 路径`);
      output = isAbsolute(value) ? value : resolve(projectRoot, value);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }

  if (extname(output).toLowerCase() !== ".zip") {
    throw new Error(`输出文件必须使用 .zip 扩展名：${output}`);
  }

  return { help: false, output };
}

function readManifest(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`缺少文件：${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertRelativePackagePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} 必须是非空相对路径`);
  }

  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label} 不能越过包目录：${value}`);
  }
  if (/[*?{}[\]]/.test(normalized)) {
    throw new Error(`${label} 暂不支持 glob：${value}`);
  }
  return normalized;
}

function stagePackage(packageName, stagingRoot) {
  const sourceRoot = join(packagesRoot, packageName);
  const manifest = readManifest(sourceRoot);
  const extensionEntries = manifest.pi?.extensions;
  if (!Array.isArray(extensionEntries) || extensionEntries.length !== 1) {
    throw new Error(`${packageName} 必须声明且只声明一个 pi.extensions 入口`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${packageName} 必须通过 package.json files 声明分发内容`);
  }

  const entry = assertRelativePackagePath(extensionEntries[0], `${packageName} 的扩展入口`);
  const sourceEntry = join(sourceRoot, entry);
  if (!existsSync(sourceEntry)) throw new Error(`${packageName} 的扩展入口不存在：${sourceEntry}`);

  const destinationRoot = join(stagingRoot, packageName);
  mkdirSync(destinationRoot, { recursive: true });
  cpSync(join(sourceRoot, "package.json"), join(destinationRoot, "package.json"));

  for (const declaredPath of manifest.files) {
    const packagePath = assertRelativePackagePath(declaredPath, `${packageName} 的 files 项`);
    const source = join(sourceRoot, packagePath);
    if (!existsSync(source)) throw new Error(`${packageName} 声明的分发文件不存在：${source}`);
    cpSync(source, join(destinationRoot, packagePath), { recursive: true });
  }

  const wrapperExtension = extname(entry) === ".js" ? ".js" : ".ts";
  writeFileSync(
    join(destinationRoot, `index${wrapperExtension}`),
    `export { default } from "./${entry.replaceAll("\\", "/")}";\n`,
    "utf8",
  );

  return { packageName, entry, wrapper: `index${wrapperExtension}` };
}

function createZip(stagingRoot, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  rmSync(outputPath, { force: true });

  let command;
  let args;
  let options;

  if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // 规避宿主环境污染的 PSModulePath：按当前 PowerShell 的 PSHOME 导入匹配版本的归档模块。
      "$ErrorActionPreference = 'Stop'; " +
        "$archiveModule = Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1'; " +
        "Import-Module -Name $archiveModule -Force -ErrorAction Stop; " +
        "$items = Get-ChildItem -LiteralPath $env:OWN_PI_PACK_SOURCE; " +
        "Compress-Archive -Path $items.FullName -DestinationPath $env:OWN_PI_PACK_DEST -Force",
    ];
    options = {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        OWN_PI_PACK_SOURCE: stagingRoot,
        OWN_PI_PACK_DEST: outputPath,
      },
    };
  } else {
    command = "zip";
    args = ["-q", "-r", outputPath, ...targets];
    options = { cwd: stagingRoot, stdio: "inherit", shell: false };
  }

  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`创建 ZIP 失败，退出码：${result.status ?? "unknown"}`);
  }
  if (!existsSync(outputPath)) throw new Error(`压缩命令未生成文件：${outputPath}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const temporaryRoot = join(projectRoot, ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const stagingRoot = mkdtempSync(join(temporaryRoot, "pack-extensions-"));
  try {
    const staged = targets.map((packageName) => stagePackage(packageName, stagingRoot));
    createZip(stagingRoot, options.output);

    console.log(`已生成：${options.output}`);
    for (const item of staged) {
      console.log(`- ${item.packageName}/${item.wrapper} -> ${item.entry}`);
    }
    console.log("将 ZIP 直接解压到 ~/.pi/agent/extensions/，然后重启 Pi 或执行 /reload。");
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
