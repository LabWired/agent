import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";

export type ResolvedCli = {
  path: string;
  version?: string;
  source: "setting" | "path" | "prefix" | "agent-home" | "missing";
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

/** Resolve labwired CLI the same way Embedder resolves its agent binary. */
export function resolveLabwiredCli(): ResolvedCli {
  const cfg = vscode.workspace.getConfiguration("labwired");
  const setting = (cfg.get<string>("cliPath") || "").trim();
  if (setting && isExecutable(setting)) {
    return { path: setting, version: readVersion(setting), source: "setting" };
  }

  const onPath = which("labwired");
  if (onPath) {
    return { path: onPath, version: readVersion(onPath), source: "path" };
  }

  const home = os.homedir();
  const prefixCandidates = [
    path.join(home, ".labwired", "bin", "labwired"),
    path.join(home, ".labwired", "bin", "labwired.cmd"),
    path.join(home, ".local", "bin", "labwired"),
  ];
  for (const c of prefixCandidates) {
    if (isExecutable(c)) {
      return { path: c, version: readVersion(c), source: "prefix" };
    }
  }

  // Dev: agent repo sibling of this extension
  // extensions/labwired-vscode → ../../bin/labwired
  try {
    const extRoot = path.dirname(path.dirname(__dirname));
    const agentBin = path.join(extRoot, "..", "..", "bin", "labwired");
    const resolved = path.resolve(agentBin);
    if (isExecutable(resolved)) {
      return {
        path: resolved,
        version: readVersion(resolved),
        source: "agent-home",
      };
    }
  } catch {
    /* ignore */
  }

  return { path: "", source: "missing" };
}
