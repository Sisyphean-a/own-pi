import { spawn } from "node:child_process";

const GOPLS_MODULE = "golang.org/x/tools/gopls@latest";
const INSTALL_TIMEOUT_MS = 180_000;
let goplsInstall;

export function installManagedServer(serverId) {
  if (serverId !== "gopls") {
    throw new Error(`no managed installer is configured for ${serverId}`);
  }
  if (!goplsInstall) {
    goplsInstall = installGopls().finally(() => {
      goplsInstall = undefined;
    });
  }
  return goplsInstall;
}

function installGopls() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "go.exe" : "go";
    const child = spawn(command, ["install", GOPLS_MODULE], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(reject, new Error("gopls installation timed out"));
    }, INSTALL_TIMEOUT_MS);

    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (code === 0) finish(resolve, true);
      else finish(reject, new Error(`gopls installation exited with code ${code ?? "unknown"}`));
    });
  });
}

function terminateProcessTree(child) {
  if (child.killed || child.pid === undefined) return;
  if (process.platform !== "win32") {
    child.kill();
    return;
  }

  const taskkill = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  taskkill.once("error", () => child.kill());
  taskkill.once("exit", (code) => {
    if (code !== 0) child.kill();
  });
}
