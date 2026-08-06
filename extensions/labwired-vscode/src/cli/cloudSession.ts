/**
 * Shared cloud session with the labwired CLI.
 * Source of truth: ~/.labwired/session/cloud.json (from `labwired login`).
 */
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

/** Load labwired login session if present. */
export function loadCloudSession(): CloudSession | undefined {
  for (const p of sessionCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as {
        access_token?: string;
        refresh_token?: string;
        project_id?: string;
        email?: string;
        api_base?: string;
        expires_at?: number;
      };
      const access = data.access_token?.trim();
      if (!access) continue;
      const apiBase = (data.api_base || "https://api.labwired.com").replace(
        /\/$/,
        ""
      );
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
