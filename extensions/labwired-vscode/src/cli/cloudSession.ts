/**
 * Shared cloud session with the labwired CLI.
 * Source of truth: ~/.labwired/session/cloud.json (from `labwired login`).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isTrustedHostedModelUrl } from "./hostedModel";

export const HOSTED_DISCLOSURE =
  "Hosted conversations are stored by LabWired under the Privacy Policy. Customer content is not used for training by default.";
export const HOSTED_DISCLOSURE_VERSION = "1";

export function isHostedLabWiredEnv(env: NodeJS.ProcessEnv): boolean {
  return isTrustedHostedModelUrl(env.LABWIRED_MODEL_URL);
}

function disclosureVersion(env: NodeJS.ProcessEnv, requested?: string): string {
  const value = requested || env.LABWIRED_HOSTED_DISCLOSURE_VERSION || HOSTED_DISCLOSURE_VERSION;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : HOSTED_DISCLOSURE_VERSION;
}

function markerPayload(version: string): string {
  return `labwired-hosted-disclosure:${version}\n`;
}

function trustedMarker(marker: string, version: string): boolean {
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    return fs.readFileSync(marker, "utf8") === markerPayload(version);
  } catch {
    return false;
  }
}

/** Return the notice only when this disclosure version has not been acknowledged. */
export function hostedDisclosureMessage(
  env: NodeJS.ProcessEnv = process.env,
  version?: string
): string | undefined {
  const safeVersion = disclosureVersion(env, version);
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  const configDir =
    env.OPENCODE_CONFIG_DIR ||
    env.LABWIRED_AGENT_CONFIG_DIR ||
    path.join(configHome, "labwired-agent");
  const dir = path.join(configDir, "state");
  const ack = path.join(dir, `hosted-disclosure-v${safeVersion}`);
  if (trustedMarker(ack, safeVersion)) return undefined;
  let temp: string | undefined;
  try {
    if (fs.existsSync(configDir)) {
      const configStat = fs.lstatSync(configDir);
      if (!configStat.isDirectory() || configStat.isSymbolicLink()) return HOSTED_DISCLOSURE;
    } else {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    if (fs.existsSync(dir)) {
      const dirStat = fs.lstatSync(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return HOSTED_DISCLOSURE;
      if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) return HOSTED_DISCLOSURE;
      fs.chmodSync(dir, 0o700);
    } else {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    temp = path.join(dir, `.hosted-disclosure-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(temp, markerPayload(safeVersion), { flag: "wx", mode: 0o600 });
    fs.linkSync(temp, ack);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" && trustedMarker(ack, safeVersion)) {
      return undefined;
    }
  } finally {
    if (temp) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
  return HOSTED_DISCLOSURE;
}

export type CloudSession = {
  accessToken: string;
  refreshToken?: string;
  projectId?: string;
  email?: string;
  apiBase: string;
  modelUrl: string;
  expiresAt?: number;
  path: string;
};

function sessionCandidates(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  if (process.env.LABWIRED_HOME) {
    out.push(path.join(process.env.LABWIRED_HOME, "session", "cloud.json"));
  }
  out.push(path.join(home, ".labwired", "session", "cloud.json"));
  return out;
}

/** Load labwired login session if present; auto-refresh when near expiry. */
export function loadCloudSession(): CloudSession | undefined {
  for (const p of sessionCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      let data = JSON.parse(fs.readFileSync(p, "utf8")) as {
        access_token?: string;
        refresh_token?: string;
        project_id?: string;
        email?: string;
        api_base?: string;
        expires_at?: number;
        updated_at?: number;
      };
      let access = data.access_token?.trim();
      if (!access) continue;
      const apiBase = (data.api_base || "https://api.labwired.com").replace(
        /\/$/,
        ""
      );
      const now = Math.floor(Date.now() / 1000);
      const exp = data.expires_at || 0;
      // Best-effort sync refresh when expired (VS Code agent terminal inherits result)
      if (data.refresh_token && exp <= now + 120) {
        try {
          // Sync python one-shot matches CLI cloud-session.sh refresh.
          execFileSync(
            "python3",
            [
              "-c",
              `
import json, time, urllib.request
from pathlib import Path
p = Path(${JSON.stringify(p)})
d = json.loads(p.read_text())
api = (d.get("api_base") or "https://api.labwired.com").rstrip("/")
body = json.dumps({"refresh_token": d["refresh_token"], "grant_type": "refresh_token"}).encode()
req = urllib.request.Request(api + "/v1/auth/refresh", data=body, headers={"Content-Type":"application/json","User-Agent":"labwired-vscode"}, method="POST")
with urllib.request.urlopen(req, timeout=20) as r:
    j = json.loads(r.read().decode())
now = int(time.time())
d["access_token"] = j["access_token"]
if j.get("refresh_token"):
    d["refresh_token"] = j["refresh_token"]
d["expires_at"] = now + int(j.get("expires_in") or 3600)
if j.get("email"):
    d["email"] = j["email"]
d["updated_at"] = now
p.write_text(json.dumps(d, indent=2) + "\\n")
`,
            ],
            { timeout: 25_000, encoding: "utf8" }
          );
          data = JSON.parse(fs.readFileSync(p, "utf8")) as typeof data;
          access = data.access_token?.trim() || access;
        } catch {
          /* keep stale token; login still required if API rejects */
        }
      }
      return {
        accessToken: access,
        refreshToken: data.refresh_token || undefined,
        projectId: data.project_id || undefined,
        email: data.email || undefined,
        apiBase,
        modelUrl: `${apiBase}/v1`,
        expiresAt: data.expires_at,
        path: p,
      };
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Env vars that `labwired` / OpenCode hosted profile expect.
 * Does not override keys already set in `base` when `preferBase` is true.
 */
export function cloudSessionEnv(
  base: NodeJS.ProcessEnv = {},
  opts?: { preferBase?: boolean }
): NodeJS.ProcessEnv {
  const s = loadCloudSession();
  if (!s) return {};
  const preferBase = opts?.preferBase ?? true;
  const env: NodeJS.ProcessEnv = {};
  const set = (key: string, value: string | undefined) => {
    if (!value) return;
    if (preferBase && base[key]) return;
    env[key] = value;
  };
  set("LABWIRED_ACCESS_TOKEN", s.accessToken);
  set("LABWIRED_REFRESH_TOKEN", s.refreshToken);
  set("LABWIRED_PROJECT", s.projectId);
  set("LABWIRED_EMAIL", s.email);
  set("LABWIRED_API_URL", s.apiBase);
  set("LABWIRED_MODEL_URL", s.modelUrl);
  set("LABWIRED_MODEL_KEY", s.accessToken);
  if (isTrustedHostedModelUrl(base.LABWIRED_MODEL_URL || env.LABWIRED_MODEL_URL)) {
    env.LABWIRED_MODEL = "labwired-default";
  }
  return env;
}
