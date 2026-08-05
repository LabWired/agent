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
exports.PlanViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const theme_1 = require("../webview/theme");
/**
 * Plan review panel (Embedder plan/review + approve).
 */
class PlanViewProvider {
    extUri;
    session;
    static viewType = "labwired.plan";
    view;
    planMarkdown = `# Plan\n\n1. Explore codebase and board constraints\n2. List files to change\n3. Define verify oracle (serial / twin)\n4. Switch to **Act** to implement\n5. **Verify** with evidence before merge\n`;
    constructor(extUri, session) {
        this.extUri = extUri;
        this.session = session;
    }
    resolveWebviewView(webviewView, _c, _t) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extUri],
        };
        webviewView.webview.html = this.html();
        webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    }
    setPlan(md) {
        this.planMarkdown = md;
        void this.view?.webview.postMessage({ type: "plan", markdown: md });
    }
    async onMessage(msg) {
        if (msg.type === "ready") {
            void this.view?.webview.postMessage({
                type: "plan",
                markdown: this.planMarkdown,
            });
        }
        if (msg.type === "save" && msg.markdown != null) {
            this.planMarkdown = msg.markdown;
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (root) {
                const uri = vscode.Uri.joinPath(root, ".labwired", "plan.md");
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ".labwired"));
                await vscode.workspace.fs.writeFile(uri, Buffer.from(this.planMarkdown, "utf8"));
                void vscode.window.showInformationMessage(`Plan saved: ${uri.fsPath}`);
            }
        }
        if (msg.type === "approve") {
            if (msg.markdown)
                this.planMarkdown = msg.markdown;
            this.session.setMode("act");
            void vscode.window.showInformationMessage("Plan approved → Act mode. Start agent to implement.");
            await vscode.commands.executeCommand("labwired.openChat");
        }
        if (msg.type === "reject") {
            void vscode.window.showInformationMessage("Plan rejected — stay in Plan mode.");
            this.session.setMode("plan");
        }
    }
    html() {
        const nonce = getNonce();
        return (0, theme_1.shellHtml)({
            nonce,
            title: "Plan",
            body: `
<div class="app">
  <div class="header">
    <h1>Plan</h1>
    <span class="badge neutral">review</span>
    <span class="grow"></span>
    <button class="ghost" id="save" type="button">Save</button>
    <button class="ghost" id="reject" type="button">Reject</button>
    <button id="approve" type="button">Approve → Act</button>
  </div>
  <div class="scroll" style="padding:10px; display:flex; flex-direction:column; gap:8px">
    <textarea id="md" style="min-height:280px; flex:1"></textarea>
    <div class="muted xs">Saved to .labwired/plan.md · approve switches to Act</div>
  </div>
</div>`,
            script: `
const md = document.getElementById('md');
document.getElementById('save').onclick = () => vscode.postMessage({ type: 'save', markdown: md.value });
document.getElementById('approve').onclick = () => vscode.postMessage({ type: 'approve', markdown: md.value });
document.getElementById('reject').onclick = () => vscode.postMessage({ type: 'reject' });
window.addEventListener('message', (e) => {
  if (e.data.type === 'plan') md.value = e.data.markdown || '';
});
vscode.postMessage({ type: 'ready' });
`,
        });
    }
}
exports.PlanViewProvider = PlanViewProvider;
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++)
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
//# sourceMappingURL=planProvider.js.map