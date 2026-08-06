"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCloudSession = loadCloudSession;
exports.cloudSessionEnv = cloudSessionEnv;
/**
 * Shared cloud session with the labwired CLI.
 * Source of truth: ~/.labwired/session/cloud.json (from `labwired login`).
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function sessionCandidates() {
    const home = os.homedir();
    const out = [];
    if (process.env.LABWIRED_HOME) {
        out.push(path.join(process.env.LABWIRED_HOME, "session", "cloud.json"));
    }
    out.push(path.join(home, ".labwired", "session", "cloud.json"));
    return out;
}
/** Load labwired login session if present. */
function loadCloudSession() {
    for (const p of sessionCandidates()) {
        try {
            if (!fs.existsSync(p))
                continue;
            const data = JSON.parse(fs.readFileSync(p, "utf8"));
            const access = data.access_token?.trim();
            if (!access)
                continue;
            const apiBase = (data.api_base || "https://api.labwired.com").replace(/\/$/, "");
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
        }
        catch {
            /* try next */
        }
    }
    return undefined;
}
/**
 * Env vars that `labwired` / OpenCode hosted profile expect.
 * Does not override keys already set in `base` when `preferBase` is true.
 */
function cloudSessionEnv(base = {}, opts) {
    const s = loadCloudSession();
    if (!s)
        return {};
    const preferBase = opts?.preferBase ?? true;
    const env = {};
    const set = (key, value) => {
        if (!value)
            return;
        if (preferBase && base[key])
            return;
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
//# sourceMappingURL=cloudSession.js.map