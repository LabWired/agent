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
exports.SessionState = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Global Pro session context (Embedder team/project/model/mode).
 */
class SessionState {
    ctx;
    mode = "act";
    emitters = new Set();
    constructor(ctx) {
        this.ctx = ctx;
        const m = this.ctx.workspaceState.get("labwired.mode");
        if (m)
            this.mode = m;
    }
    onChange(cb) {
        this.emitters.add(cb);
        return new vscode.Disposable(() => this.emitters.delete(cb));
    }
    cfg() {
        return vscode.workspace.getConfiguration("labwired");
    }
    snapshot() {
        const c = this.cfg();
        return {
            mode: this.mode,
            model: c.get("model") || "",
            team: c.get("team") || "",
            project: c.get("project") || "",
            showReasoning: c.get("showReasoningSummaries") !== false,
        };
    }
    emit() {
        const s = this.snapshot();
        for (const cb of this.emitters)
            cb(s);
    }
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
        void this.ctx.workspaceState.update("labwired.mode", mode);
        this.emit();
    }
    cycleMode() {
        // Embedder order: Act → Plan → Debug (+ Verify for LabWired)
        const order = ["act", "plan", "debug", "verify"];
        const i = order.indexOf(this.mode);
        const next = order[(i + 1) % order.length];
        this.setMode(next);
        return next;
    }
    async setModel(model) {
        await this.cfg().update("model", model, vscode.ConfigurationTarget.Global);
        this.emit();
    }
    async setTeam(team) {
        await this.cfg().update("team", team, vscode.ConfigurationTarget.Global);
        this.emit();
    }
    async setProject(project) {
        await this.cfg().update("project", project, vscode.ConfigurationTarget.Global);
        this.emit();
    }
    appUrl(path = "") {
        const base = (this.cfg().get("appUrl") || "https://app.labwired.com").replace(/\/$/, "");
        return path ? `${base}/${path.replace(/^\//, "")}` : base;
    }
}
exports.SessionState = SessionState;
//# sourceMappingURL=sessionState.js.map