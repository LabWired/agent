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
exports.resolveLabwiredCli = resolveLabwiredCli;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const vscode = __importStar(require("vscode"));
function isExecutable(p) {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function which(cmd) {
    try {
        const out = (0, child_process_1.execFileSync)(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" })
            .trim()
            .split(/\r?\n/)[0];
        return out && isExecutable(out) ? out : undefined;
    }
    catch {
        return undefined;
    }
}
function readVersion(cli) {
    try {
        const out = (0, child_process_1.execFileSync)(cli, ["version"], {
            encoding: "utf8",
            timeout: 8000,
            env: process.env,
        });
        const m = out.match(/version\s+(\S+)/i);
        return m?.[1];
    }
    catch {
        return undefined;
    }
}
function parseSemver(v) {
    if (!v)
        return [0];
    return v
        .replace(/^v/i, "")
        .split(/[.+-]/)
        .map((x) => parseInt(x, 10) || 0);
}
/** true if a is strictly greater than b */
function versionGt(a, b) {
    const aa = parseSemver(a);
    const bb = parseSemver(b);
    const n = Math.max(aa.length, bb.length);
    for (let i = 0; i < n; i++) {
        const x = aa[i] || 0;
        const y = bb[i] || 0;
        if (x > y)
            return true;
        if (x < y)
            return false;
    }
    return false;
}
function pickBest(candidates) {
    let best;
    for (const c of candidates) {
        if (!isExecutable(c.path))
            continue;
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
function resolveLabwiredCli(extensionPath) {
    const cfg = vscode.workspace.getConfiguration("labwired");
    const setting = (cfg.get("cliPath") || "").trim();
    if (setting && isExecutable(setting)) {
        return { path: setting, version: readVersion(setting), source: "setting" };
    }
    const home = os.homedir();
    const candidates = [];
    // Workbench lives at agent/extensions/labwired-vscode → ../../bin/labwired
    const roots = [];
    if (extensionPath)
        roots.push(extensionPath);
    try {
        // out/cli → extension root
        roots.push(path.dirname(path.dirname(__dirname)));
    }
    catch {
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
    if (onPath)
        candidates.push({ path: onPath, source: "path" });
    for (const c of [
        path.join(home, ".labwired", "bin", "labwired"),
        path.join(home, ".labwired", "bin", "labwired.cmd"),
        path.join(home, ".local", "bin", "labwired"),
    ]) {
        candidates.push({ path: c, source: "prefix" });
    }
    return pickBest(candidates);
}
//# sourceMappingURL=resolver.js.map