import { spawn } from "node:child_process";

function runUpdate(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve(succeeded);
    };
    const onError = () => finish(false);
    const onClose = (code) => finish(code === 0);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

const [command, baseArgsJson, ...sources] = process.argv.slice(2);
let baseArgs;
try {
  baseArgs = JSON.parse(baseArgsJson ?? "null");
} catch {
  baseArgs = undefined;
}

if (typeof command !== "string" || !Array.isArray(baseArgs) || sources.length === 0) {
  process.exitCode = 1;
} else {
  let succeeded = true;
  for (const source of sources) {
    const updated = await runUpdate(command, [
      ...baseArgs,
      "update",
      "--extension",
      source,
    ]);
    if (!updated) succeeded = false;
  }
  process.exitCode = succeeded ? 0 : 1;
}
