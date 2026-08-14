import { posix, win32 } from "node:path";

function descriptor(path, platform, which) {
  if (platform === "win32" && win32.extname(path).toLowerCase() === ".ps1") {
    const host = which("powershell.exe") || which("pwsh.exe");
    return host
      ? { command: host, argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path], path }
      : null;
  }
  return { command: path, argsPrefix: [], path };
}

export function resolveAgentLauncher({ platform, env, agentRoot, home, exists, which }) {
  const explicit = env.LABWIRED_AGENT_CLI_PATH;
  if (explicit && exists(explicit)) return descriptor(explicit, platform, which);

  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  const sibling = paths.join(agentRoot, "bin", windows ? "labwired.ps1" : "labwired-agent");
  if (exists(sibling)) return descriptor(sibling, platform, which);

  const pathLauncher = which(windows ? "labwired.ps1" : "labwired-agent");
  if (pathLauncher && exists(pathLauncher)) return descriptor(pathLauncher, platform, which);

  const legacy = windows
    ? paths.join(home, ".labwired", "bin", "labwired.ps1")
    : paths.join(home, ".labwired", "agent", "bin", "labwired-agent");
  if (exists(legacy)) return descriptor(legacy, platform, which);
  return null;
}
