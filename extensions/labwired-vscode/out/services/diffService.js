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
exports.DiffService = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Diff approval surface (Embedder permission dialog equivalent).
 * Uses VS Code native diff editor + modal for accept/reject/redirect.
 */
class DiffService {
    ctx;
    scheme = "labwired-diff";
    constructor(ctx) {
        this.ctx = ctx;
        const provider = new (class {
            content = new Map();
            onDidChange;
            set(uri, text) {
                this.content.set(uri.toString(), text);
            }
            provideTextDocumentContent(uri) {
                return this.content.get(uri.toString()) || "";
            }
        })();
        this.provider = provider;
        ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(this.scheme, provider));
    }
    provider;
    async proposeEdit(opts) {
        const left = vscode.Uri.parse(`${this.scheme}:before/${encodeURIComponent(opts.pathLabel)}?t=${Date.now()}`);
        const right = vscode.Uri.parse(`${this.scheme}:after/${encodeURIComponent(opts.pathLabel)}?t=${Date.now()}`);
        this.provider.set(left, opts.before);
        this.provider.set(right, opts.after);
        await vscode.commands.executeCommand("vscode.diff", left, right, opts.title);
        const pick = await vscode.window.showInformationMessage(`Apply change to ${opts.pathLabel}?`, { modal: true }, "Accept", "Reject", "Redirect…");
        if (pick === "Accept")
            return "accept";
        if (pick === "Reject")
            return "reject";
        if (pick === "Redirect…")
            return "redirect";
        return undefined;
    }
}
exports.DiffService = DiffService;
//# sourceMappingURL=diffService.js.map