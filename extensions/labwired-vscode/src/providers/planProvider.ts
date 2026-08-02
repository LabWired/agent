import * as vscode from "vscode";
import type { SessionState } from "../services/sessionState";
import { shellHtml } from "../webview/theme";

/**
 * Plan review panel (Embedder plan/review + approve).
 */
export class PlanViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "labwired.plan";
  private view?: vscode.WebviewView;
  private planMarkdown = `# Plan\n\n1. Explore codebase and board constraints\n2. List files to change\n3. Define verify oracle (serial / twin)\n4. Switch to **Act** to implement\n5. **Verify** with evidence before merge\n`;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly session: SessionState
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _c: vscode.WebviewViewResolveContext,
    _t: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  setPlan(md: string) {
    this.planMarkdown = md;
    void this.view?.webview.postMessage({ type: "plan", markdown: md });
  }

  private async onMessage(msg: { type: string; markdown?: string }) {
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
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(root, ".labwired")
        );
        await vscode.workspace.fs.writeFile(
          uri,
          Buffer.from(this.planMarkdown, "utf8")
        );
        void vscode.window.showInformationMessage(`Plan saved: ${uri.fsPath}`);
      }
    }
    if (msg.type === "approve") {
      if (msg.markdown) this.planMarkdown = msg.markdown;
      this.session.setMode("act");
      void vscode.window.showInformationMessage(
        "Plan approved → Act mode. Start agent to implement."
      );
      await vscode.commands.executeCommand("labwired.openChat");
    }
    if (msg.type === "reject") {
      void vscode.window.showInformationMessage("Plan rejected — stay in Plan mode.");
      this.session.setMode("plan");
    }
  }

  private html(): string {
    const nonce = getNonce();
    return shellHtml({
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

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
