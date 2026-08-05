"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LW_MARK_SVG_LG = exports.LW_MARK_SVG = exports.LW_CSS = void 0;
exports.csp = csp;
exports.shellHtml = shellHtml;
/**
 * Embedder clone foundation — tokens & layout mirrored from
 * embedder.embedder-vscode webview CSS (v0.3.163), rebranded LabWired.
 *
 * Source: docs/competitive/embedder-vscode/unpacked/extension/out/webview/index.css
 */
exports.LW_CSS = `
:root {
  --bg: var(--vscode-editor-background, #1e1e1e);
  --bg-panel: var(--vscode-sideBar-background, var(--bg));
  --bg-element: var(--vscode-input-background, var(--bg));
  --bg-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.16));
  --bg-active: var(--vscode-list-activeSelectionBackground, rgba(128, 128, 128, 0.22));
  --text: var(--vscode-editor-foreground, #cccccc);
  --text-muted: var(--vscode-descriptionForeground, #9d9d9d);
  --text-user: var(--vscode-descriptionForeground, #a6a6a6);
  --border: var(--vscode-panel-border, #3c3c3c);
  --border-active: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #007fd4));
  --focus: var(--vscode-focusBorder, #007fd4);
  --primary: var(--vscode-textLink-foreground, #3794ff);
  --secondary: var(--vscode-symbolIcon-operatorForeground, #b180d7);
  --warning: var(--vscode-inputValidation-warningForeground, #cca700);
  --success: var(--vscode-testing-iconPassed, #73c991);
  --error: var(--vscode-errorForeground, #f14c4c);
  --button-bg: var(--vscode-button-background, #0e639c);
  --button-fg: var(--vscode-button-foreground, #ffffff);
  --button-hover: var(--vscode-button-hoverBackground, #1177bb);
  /* LabWired brand overlays Embedder's --embedder-brand where we need accent */
  --brand: #0056b3;
  --brand-soft: rgba(0, 86, 179, 0.18);
  --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif);
  --font-size: var(--vscode-font-size, 13px);
  --font-size-2xs: calc(var(--font-size) * 0.69);
  --font-size-xs: calc(var(--font-size) * 0.77);
  --font-size-sm: calc(var(--font-size) * 0.85);
  --font-size-md: calc(var(--font-size) * 0.92);
  --font-size-lg: var(--font-size);
  --line-height: 1.45;
  --embedder-radius: var(--vscode-border-radius, 7px);
  --composer-row-height: 22px;
  --composer-pill-height: var(--composer-row-height);
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  margin: 0 !important;
  padding: 0 !important;
  width: 100%;
  height: 100%;
}
*:focus-visible {
  outline: 1px solid var(--focus);
  outline-offset: 1px;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-family);
  font-size: var(--font-size);
  line-height: var(--line-height);
  height: 100vh;
  overflow: hidden;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

/* ——— Tab strip (chat tabs) ——— */
.tab-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 4px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex-shrink: 0;
  overflow-x: auto;
  min-height: 32px;
}
.tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-size-sm);
  padding: 7px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab:hover { color: var(--text); background: var(--bg-hover); }
.tab.active {
  color: var(--text);
  border-bottom-color: var(--brand);
}
.tab-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
  padding-right: 4px;
}

/* ——— Message list (Embedder .message-list / .turn / .message) ——— */
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  scroll-behavior: smooth;
  min-height: 0;
}
.turn { display: block; }
.message {
  padding: 6px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.message-prefix {
  font-size: var(--font-size-2xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.message.user .message-prefix { color: var(--brand); }
.message-content {
  color: var(--text);
  font-size: var(--font-size);
  line-height: var(--line-height);
  white-space: pre-wrap;
  word-break: break-word;
}
.message.user .message-content { color: var(--text); }
.message.system .message-content {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}
.tool-container {
  margin-top: 2px;
  width: 100%;
}
.tool-call {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-element);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
}
.tool-status-success { color: var(--success); }
.tool-status-error { color: var(--error); }

/* ——— Empty state (Embedder .empty-state) ——— */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px 48px;
  text-align: center;
  color: var(--text-muted);
  gap: 4px;
  flex: 1;
}
.empty-logo-mark {
  width: 56px;
  height: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  color: var(--text);
}
.empty-state h2 {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.empty-state p {
  font-size: var(--font-size-sm);
  max-width: 260px;
  line-height: 1.45;
  margin: 4px 0 0;
}

/* ——— Composer (Embedder .composer / .composer-shell) ——— */
.composer {
  flex-shrink: 0;
  padding: 8px 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 0;
  align-items: stretch;
  background: var(--bg);
  position: relative;
}
.composer-shell {
  border: 1px solid var(--border);
  border-radius: var(--embedder-radius);
  background: var(--bg-panel);
  overflow: hidden;
}
.composer-shell:focus-within {
  border-color: var(--border);
  box-shadow: none;
}
.composer-shell.mode-plan { border-color: var(--primary); }
.composer-shell.mode-debug { border-color: var(--warning); }
.composer-shell.mode-verify { border-color: var(--success); }
.composer-shell.input-mode-bash { border-color: var(--warning); }
.composer-shell.input-mode-serial { border-color: var(--primary); }

.composer-input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--font-size);
  line-height: var(--line-height);
  padding: 10px 12px 6px;
  resize: none;
  min-height: 56px;
  max-height: 160px;
  outline: none;
  font-family: var(--font-family);
}
.composer-input::placeholder { color: var(--text-muted); opacity: 0.8; }

.composer-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px 8px;
  min-height: calc(var(--composer-row-height) + 8px);
}

/* Mode pill — single control that cycles (Embedder) */
.composer-mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--composer-pill-height);
  padding: 2px 6px 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--embedder-radius);
  font-size: var(--font-size-xs);
  line-height: 1.3;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  color: var(--text-muted);
  background: transparent;
  font-family: var(--font-family);
  cursor: pointer;
  appearance: none;
}
.composer-mode-pill:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
  border-color: color-mix(in srgb, var(--border) 50%, var(--text-muted));
}
.composer-shell.mode-plan .composer-mode-pill {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 60%, var(--border));
}
.composer-shell.mode-debug .composer-mode-pill {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
}
.composer-shell.mode-verify .composer-mode-pill {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 55%, var(--border));
}
.composer-shell.mode-act .composer-mode-pill {
  color: var(--text-muted);
}

.composer-spacer { flex: 1; }

.composer-icon-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  width: 26px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.composer-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.composer-send {
  appearance: none;
  border: none;
  background: var(--button-bg);
  color: var(--button-fg);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 500;
  height: var(--composer-pill-height);
  padding: 0 10px;
  border-radius: var(--embedder-radius);
  cursor: pointer;
}
.composer-send:hover { background: var(--button-hover); }
.composer-send:disabled { opacity: 0.45; cursor: default; }

/* Quick actions under empty / above composer (optional strip) */
.quick-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}
.quick-action {
  appearance: none;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--font-size-sm);
  padding: 6px 12px;
  border-radius: var(--embedder-radius);
  cursor: pointer;
}
.quick-action:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--border) 40%, var(--text-muted));
}

/* Shared secondary panels */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex-shrink: 0;
  min-height: 36px;
}
.header h1 {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
}
.badge {
  font-size: var(--font-size-2xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-muted);
}
.badge.ok { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
.badge.fail { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }
.badge.brand { background: var(--brand-soft); color: var(--brand); }
.grow { flex: 1; min-width: 0; }
.muted { color: var(--text-muted); }
.small { font-size: var(--font-size-sm); }
.xs { font-size: var(--font-size-xs); }
.mono {
  font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
button.ghost {
  appearance: none;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--font-size-xs);
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}
button.ghost:hover { background: var(--bg-hover); }
button.primary {
  appearance: none;
  border: none;
  background: var(--button-bg);
  color: var(--button-fg);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
button.primary:hover { background: var(--button-hover); }
.card {
  border: 1px solid var(--border);
  border-radius: var(--embedder-radius);
  background: var(--bg-element);
  padding: 10px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  min-width: 48px;
}
input[type="text"], input[type="number"], select, textarea.plain {
  width: 100%;
  background: var(--bg-element);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 5px 8px;
  font: inherit;
  font-size: var(--font-size-sm);
  outline: none;
}
input:focus, select:focus, textarea.plain:focus {
  border-color: var(--focus);
}
.scroll { flex: 1; overflow: auto; min-height: 0; }
.status-strip {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
`;
function csp(nonce) {
    return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data: https:; font-src data:;`;
}
function shellHtml(opts) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp(opts.nonce)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark light" />
  <title>${opts.title}</title>
  <style nonce="${opts.nonce}">${exports.LW_CSS}</style>
</head>
<body>
${opts.body}
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();
${opts.script}
</script>
</body>
</html>`;
}
exports.LW_MARK_SVG = `<svg class="logo" width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" fill="none">
  <path d="M11 7V23H23" stroke="#0056b3" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="11" cy="7" r="2.5" fill="currentColor" opacity="0.85"/>
  <circle cx="23" cy="23" r="2.5" fill="#0056b3"/>
</svg>`;
exports.LW_MARK_SVG_LG = `<svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true" fill="none">
  <path d="M11 7V23H23" stroke="#0056b3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="11" cy="7" r="2.75" fill="currentColor" opacity="0.9"/>
  <circle cx="23" cy="23" r="2.75" fill="#0056b3"/>
</svg>`;
//# sourceMappingURL=theme.js.map