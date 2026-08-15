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
exports.HOSTED_DISCLOSURE_VERSION = exports.HOSTED_DISCLOSURE = void 0;
exports.isHostedLabWiredEnv = isHostedLabWiredEnv;
exports.hostedDisclosureMessage = hostedDisclosureMessage;
exports.loadCloudSession = loadCloudSession;
exports.cloudSessionEnv = cloudSessionEnv;
/**
 * Shared cloud session with the labwired CLI.
 * Source of truth: ~/.labwired/session/cloud.json (from `labwired login`).
 */
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const hostedModel_1 = require("./hostedModel");
exports.HOSTED_DISCLOSURE = "Hosted conversations are stored by LabWired under the Privacy Policy. Customer content is not used for training by default.";
exports.HOSTED_DISCLOSURE_VERSION = "1";
function isHostedLabWiredEnv(env) {
    return (0, hostedModel_1.isTrustedHostedModelUrl)(env.LABWIRED_MODEL_URL);
}
function disclosureVersion(env, requested) {
    const value = requested || env.LABWIRED_HOSTED_DISCLOSURE_VERSION || exports.HOSTED_DISCLOSURE_VERSION;
    return /^[A-Za-z0-9._-]+$/.test(value) ? value : exports.HOSTED_DISCLOSURE_VERSION;
}
function markerPayload(version) {
    return `labwired-hosted-disclosure:${version}\n`;
}
function trustedMarker(marker, version) {
    try {
        const stat = fs.lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
            return false;
        if (typeof process.getuid === "function" && stat.uid !== process.getuid())
            return false;
        return fs.readFileSync(marker, "utf8") === markerPayload(version);
    }
    catch {
        return false;
    }
}
function privateOwnedDirectory(directory) {
    try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return undefined;
        if (typeof process.getuid === "function" && stat.uid !== process.getuid())
            return undefined;
        fs.chmodSync(directory, 0o700);
        return fs.lstatSync(directory);
    }
    catch {
        return undefined;
    }
}
function sameDirectory(directory, expected) {
    const current = privateOwnedDirectory(directory);
    return !!current && current.dev === expected.dev && current.ino === expected.ino;
}
/** Return the notice only when this disclosure version has not been acknowledged. */
function hostedDisclosureMessage(env = process.env, version) {
    const safeVersion = disclosureVersion(env, version);
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
    const configDir = env.OPENCODE_CONFIG_DIR ||
        env.LABWIRED_AGENT_CONFIG_DIR ||
        path.join(configHome, "labwired-agent");
    const dir = path.join(configDir, "state");
    const ack = path.join(dir, `hosted-disclosure-v${safeVersion}`);
    let temp;
    let stateIdentity;
    try {
        if (fs.existsSync(configDir)) {
            if (!privateOwnedDirectory(configDir))
                return exports.HOSTED_DISCLOSURE;
        }
        else {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
            if (!privateOwnedDirectory(configDir))
                return exports.HOSTED_DISCLOSURE;
        }
        if (fs.existsSync(dir)) {
            stateIdentity = privateOwnedDirectory(dir);
        }
        else {
            fs.mkdirSync(dir, { mode: 0o700 });
            stateIdentity = privateOwnedDirectory(dir);
        }
        if (!stateIdentity)
            return exports.HOSTED_DISCLOSURE;
        if (trustedMarker(ack, safeVersion))
            return undefined;
        temp = path.join(dir, `.hosted-disclosure-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        fs.writeFileSync(temp, markerPayload(safeVersion), { flag: "wx", mode: 0o600 });
        if (!sameDirectory(dir, stateIdentity))
            return exports.HOSTED_DISCLOSURE;
        fs.linkSync(temp, ack);
        if (!sameDirectory(dir, stateIdentity))
            return exports.HOSTED_DISCLOSURE;
    }
    catch (err) {
        if (err.code === "EEXIST" &&
            stateIdentity &&
            sameDirectory(dir, stateIdentity) &&
            trustedMarker(ack, safeVersion)) {
            return undefined;
        }
    }
    finally {
        if (temp && stateIdentity && sameDirectory(dir, stateIdentity)) {
            try {
                fs.unlinkSync(temp);
            }
            catch { /* best effort */ }
        }
    }
    return exports.HOSTED_DISCLOSURE;
}
function sessionCandidates() {
    const home = os.homedir();
    const out = [];
    if (process.env.LABWIRED_HOME) {
        out.push(path.join(process.env.LABWIRED_HOME, "session", "cloud.json"));
    }
    out.push(path.join(home, ".labwired", "session", "cloud.json"));
    return out;
}
/** Load labwired login session if present; auto-refresh when near expiry. */
function loadCloudSession() {
    for (const p of sessionCandidates()) {
        try {
            if (!fs.existsSync(p))
                continue;
            let data = JSON.parse(fs.readFileSync(p, "utf8"));
            let access = data.access_token?.trim();
            if (!access)
                continue;
            const apiBase = (data.api_base || "https://api.labwired.com").replace(/\/$/, "");
            const now = Math.floor(Date.now() / 1000);
            const exp = data.expires_at || 0;
            // Best-effort sync refresh when expired (VS Code agent terminal inherits result)
            if (data.refresh_token && exp <= now + 120) {
                try {
                    // Sync python one-shot matches CLI cloud-session.sh refresh.
                    (0, child_process_1.execFileSync)("python3", [
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
                    ], { timeout: 25_000, encoding: "utf8" });
                    data = JSON.parse(fs.readFileSync(p, "utf8"));
                    access = data.access_token?.trim() || access;
                }
                catch {
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
    if ((0, hostedModel_1.isTrustedHostedModelUrl)(base.LABWIRED_MODEL_URL || env.LABWIRED_MODEL_URL)) {
        env.LABWIRED_MODEL = "labwired-default";
    }
    return env;
}
//# sourceMappingURL=cloudSession.js.map