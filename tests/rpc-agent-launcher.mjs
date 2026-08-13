import assert from "node:assert/strict";
import { resolveAgentLauncher } from "../server/agent-launcher.mjs";

function resolveFixture({ platform = "linux", present = [], found = {}, explicit } = {}) {
  const calls = [];
  const launcher = resolveAgentLauncher({
    platform,
    env: explicit ? { LABWIRED_AGENT_CLI_PATH: explicit } : {},
    agentRoot: platform === "win32" ? "C:\\kit" : "/kit",
    home: platform === "win32" ? "C:\\home" : "/home/test",
    exists: (path) => present.includes(path),
    which: (name) => { calls.push(name); return found[name] || null; },
  });
  return { launcher, calls };
}

{
  const { launcher, calls } = resolveFixture({ platform: "win32", present: ["C:\\kit\\bin\\labwired.ps1"], found: { "powershell.exe": "C:\\Windows\\powershell.exe", "labwired.ps1": "C:\\bad\\labwired.ps1" } });
  assert.equal(launcher.path, "C:\\kit\\bin\\labwired.ps1");
  assert.equal(launcher.command, "C:\\Windows\\powershell.exe");
  assert.deepEqual(launcher.argsPrefix.slice(-2), ["-File", "C:\\kit\\bin\\labwired.ps1"]);
  assert.equal(calls.includes("labwired.ps1"), false, "trusted sibling must avoid lower-priority PATH lookup");
}

{
  const path = "C:\\userbin\\labwired.ps1";
  const { launcher } = resolveFixture({ platform: "win32", present: [path], found: { "labwired.ps1": path, "powershell.exe": "powershell.exe" } });
  assert.equal(launcher.path, path);
  assert.equal(launcher.command, "powershell.exe");
}

{
  const legacy = "C:\\home\\.labwired\\bin\\labwired.ps1";
  const { launcher } = resolveFixture({ platform: "win32", present: [legacy], found: { "powershell.exe": "powershell.exe" } });
  assert.equal(launcher.path, legacy);
}

console.log("ok   RPC platform launcher resolution");
