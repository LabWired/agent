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
/** Resolve labwired CLI the same way Embedder resolves its agent binary. */
function resolveLabwiredCli() {
    const cfg = vscode.workspace.getConfiguration("labwired");
    const setting = (cfg.get("cliPath") || "").trim();
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
    }
    catch {
        /* ignore */
    }
    return { path: "", source: "missing" };
}
//# sourceMappingURL=resolver.js.map