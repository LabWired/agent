import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";

export type ResolvedCli = {
  path: string;
  version?: string;
  source:
    | "setting"
    | "agent-kit"
    | "agent-home"
    | "path"
    | "prefix"
    | "missing";
};

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(cmd: string): string | undefined {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { encoding: "utf8" }
    )
      .trim()
      .split(/\r?\n/)[0];
    return out && isExecutable(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function readVersion(cli: string): string | undefined {
  try {
    const out = execFileSync(cli, ["version"], {
      encoding: "utf8",
      timeout: 8000,
      env: process.env,
    });
    const m = out.match(/version\s+(\S+)/i);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function parseSemver(v?: string): number[] {
  if (!v) return [0];
  return v
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0);
}

/** true if a is strictly greater than b */
function versionGt(a?: string, b?: string): boolean {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] || 0;
    const y = bb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function pickBest(candidates: { path: string; source: ResolvedCli["source"] }[]): ResolvedCli {
  let best: ResolvedCli | undefined;
  for (const c of candidates) {
    if (!isExecutable(c.path)) continue;
    const version = readVersion(c.path);
    if (!best || versionGt(version, best.version)) {
      best = { path: c.path, version, source: c.source };
    }
  }
  return best || { path: "", source: "missing" };
}

/**
 * Resolve labwired CLI the same way Embedder resolves its agent binary.
 *
 * Prefer the newest kit: settings pin wins; otherwise compare agent kit next to
 * this extension, ~/.labwired/agent, PATH, and prefix shims so a stale PATH
 * install does not win over the workbench-bundled agent.
 */
export function resolveLabwiredCli(extensionPath?: string): ResolvedCli {
  const cfg = vscode.workspace.getConfiguration("labwired");
  const setting = (cfg.get<string>("cliPath") || "").trim();
  if (setting && isExecutable(setting)) {
    return { path: setting, version: readVersion(setting), source: "setting" };
  }

  const home = os.homedir();
  const candidates: { path: string; source: ResolvedCli["source"] }[] = [];

  // Workbench lives at agent/extensions/labwired-vscode → ../../bin/labwired
  const roots: string[] = [];
  if (extensionPath) roots.push(extensionPath);
  try {
    // out/cli → extension root
    roots.push(path.dirname(path.dirname(__dirname)));
  } catch {
    /* */
  }
  for (const root of roots) {
    const agentBin = path.resolve(root, "..", "..", "bin", "labwired");
    candidates.push({ path: agentBin, source: "agent-kit" });
    if (process.platform === "win32") {
      candidates.push({
        path: path.resolve(root, "..", "..", "bin", "labwired.cmd"),
        source: "agent-kit",
      });
    }
  }

  candidates.push({
    path: path.join(home, ".labwired", "agent", "bin", "labwired"),
    source: "agent-home",
  });
  if (process.platform === "win32") {
    candidates.push({
      path: path.join(home, ".labwired", "agent", "bin", "labwired.cmd"),
      source: "agent-home",
    });
  }

  const onPath = which("labwired");
  if (onPath) candidates.push({ path: onPath, source: "path" });

  for (const c of [
    path.join(home, ".labwired", "bin", "labwired"),
    path.join(home, ".labwired", "bin", "labwired.cmd"),
    path.join(home, ".local", "bin", "labwired"),
  ]) {
    candidates.push({ path: c, source: "prefix" });
  }

  return pickBest(candidates);
}
