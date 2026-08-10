#!/usr/bin/env node
/**
 * Cross-platform npm entry for @labwired/agent
 *
 *   npm i -g @labwired/agent
 *   npx @labwired/agent
 *   npx @labwired/agent --prefix /opt/labwired
 *
 * Routes to install.sh (macOS/Linux/WSL) or install.ps1 (Windows).
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const args = process.argv.slice(2).filter((a) => a !== "--postinstall");
const isPost = process.argv.includes("--postinstall");

// Installing this npm package as a dependency must not mutate the user's
// product installation. `npx @labwired/agent` remains the explicit installer.
if (isPost) process.exit(0);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: isWin,
    ...opts,
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function has(file) {
  return fs.existsSync(path.join(root, file));
}

if (!isPost) {
  console.log(
    `==> LabWired Agent install (${isWin ? "windows" : process.platform}-${os.arch()})`
  );
}

if (isWin) {
  const ps1 = has("scripts/install.ps1")
    ? path.join(root, "scripts", "install.ps1")
    : path.join(root, "scripts", "agent-install.ps1");
  if (!fs.existsSync(ps1)) {
    console.error("labwired-agent: Windows installer missing");
    process.exit(1);
  }
  // Map --prefix DIR for PowerShell
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prefix" && args[i + 1]) {
      psArgs.push("-Prefix", args[++i]);
    } else if (args[i] === "--minimal") {
      psArgs.push("-Minimal");
    } else if (args[i] === "--agent-only") {
      psArgs.push("-AgentOnly");
    } else if (args[i] === "--full") {
      psArgs.push("-Full");
    } else if (args[i] === "--airgap") {
      psArgs.push("-Airgap");
    } else if (args[i].startsWith("--prefix=")) {
      psArgs.push("-Prefix", args[i].slice("--prefix=".length));
    } else {
      psArgs.push(args[i]);
    }
  }
  if (!psArgs.includes("-Full") && !psArgs.includes("-Minimal") && !psArgs.includes("-AgentOnly")) {
    psArgs.push("-AgentOnly");
  }
  run("powershell.exe", psArgs);
} else {
  const sh = has("install.sh")
    ? path.join(root, "install.sh")
    : path.join(root, "scripts", "agent-install.sh");
  if (!fs.existsSync(sh)) {
    console.error("labwired-agent: Unix installer missing");
    process.exit(1);
  }
  const shArgs = args.some((a) => a === "--agent-only" || a === "--minimal" || a === "--full" || a === "--with-core-tools")
    ? args
    : ["--agent-only", ...args];
  run("bash", [sh, ...shArgs]);
}
