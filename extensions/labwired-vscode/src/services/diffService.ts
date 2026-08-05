import * as vscode from "vscode";

/**
 * Diff approval surface (Embedder permission dialog equivalent).
 * Uses VS Code native diff editor + modal for accept/reject/redirect.
 */
export class DiffService {
  private readonly scheme = "labwired-diff";

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const provider = new (class implements vscode.TextDocumentContentProvider {
      private content = new Map<string, string>();
      onDidChange?: vscode.Event<vscode.Uri>;
      set(uri: vscode.Uri, text: string) {
        this.content.set(uri.toString(), text);
      }
      provideTextDocumentContent(uri: vscode.Uri): string {
        return this.content.get(uri.toString()) || "";
      }
    })();

    this.provider = provider;
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(this.scheme, provider)
    );
  }

  private provider: {
    set(uri: vscode.Uri, text: string): void;
    provideTextDocumentContent(uri: vscode.Uri): string;
  };

  async proposeEdit(opts: {
    title: string;
    pathLabel: string;
    before: string;
    after: string;
  }): Promise<"accept" | "reject" | "redirect" | undefined> {
    const left = vscode.Uri.parse(
      `${this.scheme}:before/${encodeURIComponent(opts.pathLabel)}?t=${Date.now()}`
    );
    const right = vscode.Uri.parse(
      `${this.scheme}:after/${encodeURIComponent(opts.pathLabel)}?t=${Date.now()}`
    );
    this.provider.set(left, opts.before);
    this.provider.set(right, opts.after);

    await vscode.commands.executeCommand("vscode.diff", left, right, opts.title);

    const pick = await vscode.window.showInformationMessage(
      `Apply change to ${opts.pathLabel}?`,
      { modal: true },
      "Accept",
      "Reject",
      "Redirect…"
    );
    if (pick === "Accept") return "accept";
    if (pick === "Reject") return "reject";
    if (pick === "Redirect…") return "redirect";
    return undefined;
  }
}
