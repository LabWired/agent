/**
 * Shared cloud session with the labwired CLI.
 * Source of truth: ~/.labwired/session/cloud.json (from `labwired login`).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  set("LABWIRED_MODEL", "labwired-default");
  return env;
}
