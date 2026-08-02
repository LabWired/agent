import * as vscode from "vscode";

/** Quiet IDE schematic viewer — Embedder-density chrome, LabWired accent. */
export class SchematicEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "labwired.schematicEditor";

  constructor(private readonly extUri: vscode.Uri) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };

    const update = () => {
      const text = document.getText();
      const comps = (text.match(/\(symbol\b/g) || []).length;
      const wires = (text.match(/\(wire\b/g) || []).length;
      const labels = (text.match(/\(label\b/g) || []).length;
      webviewPanel.webview.html = /* html */ `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="color-scheme" content="dark light"/>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --panel: var(--vscode-sideBar-background, var(--bg));
    --text: var(--vscode-editor-foreground, #ccc);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --border: var(--vscode-panel-border, rgba(128,128,128,.35));
    --brand: #0056b3;
  }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
  }
  .header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .header h1 { margin: 0; font-size: 12px; font-weight: 600; }
  .stats { display: flex; gap: 16px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .stats strong { color: var(--text); font-weight: 600; }
  .path { padding: 8px 12px; font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); word-break: break-all; }
  pre {
    margin: 0; padding: 12px;
    font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
    font-size: 11px; line-height: 1.45;
    white-space: pre-wrap; max-height: calc(100vh - 120px); overflow: auto;
    color: var(--muted);
  }
</style>
</head><body>
  <div class="header">
    <svg width="14" height="14" viewBox="0 0 32 32" fill="none"><path d="M11 7V23H23" stroke="#0056b3" stroke-width="2.75" stroke-linecap="round"/><circle cx="11" cy="7" r="2.5" fill="currentColor" opacity=".8"/><circle cx="23" cy="23" r="2.5" fill="#0056b3"/></svg>
    <h1>Schematic</h1>
  </div>
  <div class="path">${escapeHtml(document.fileName)}</div>
  <div class="stats">
    <span><strong>${comps}</strong> symbols</span>
    <span><strong>${wires}</strong> wires</span>
    <span><strong>${labels}</strong> labels</span>
  </div>
  <pre>${escapeHtml(text.slice(0, 200000))}</pre>
</body></html>`;
    };

    update();
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) update();
    });
    webviewPanel.onDidDispose(() => sub.dispose());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
