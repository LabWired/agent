import * as vscode from "vscode";

export type AgentMode = "plan" | "act" | "debug" | "verify";

export type SessionSnapshot = {
  mode: AgentMode;
  model: string;
  team: string;
  project: string;
  showReasoning: boolean;
};

/**
 * Global Pro session context (Embedder team/project/model/mode).
 */
export class SessionState {
  private mode: AgentMode = "act";
  private readonly emitters = new Set<(s: SessionSnapshot) => void>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const m = this.ctx.workspaceState.get<AgentMode>("labwired.mode");
    if (m) this.mode = m;
  }

  onChange(cb: (s: SessionSnapshot) => void): vscode.Disposable {
    this.emitters.add(cb);
    return new vscode.Disposable(() => this.emitters.delete(cb));
  }

  private cfg() {
    return vscode.workspace.getConfiguration("labwired");
  }

  snapshot(): SessionSnapshot {
    const c = this.cfg();
    return {
      mode: this.mode,
      model: c.get<string>("model") || "",
      team: c.get<string>("team") || "",
      project: c.get<string>("project") || "",
      showReasoning: c.get<boolean>("showReasoningSummaries") !== false,
    };
  }

  private emit() {
    const s = this.snapshot();
    for (const cb of this.emitters) cb(s);
  }

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode) {
    this.mode = mode;
    void this.ctx.workspaceState.update("labwired.mode", mode);
    this.emit();
  }

  cycleMode(): AgentMode {
    // Embedder order: Act → Plan → Debug (+ Verify for LabWired)
    const order: AgentMode[] = ["act", "plan", "debug", "verify"];
    const i = order.indexOf(this.mode);
    const next = order[(i + 1) % order.length];
    this.setMode(next);
    return next;
  }

  async setModel(model: string) {
    await this.cfg().update("model", model, vscode.ConfigurationTarget.Global);
    this.emit();
  }

  async setTeam(team: string) {
    await this.cfg().update("team", team, vscode.ConfigurationTarget.Global);
    this.emit();
  }

  async setProject(project: string) {
    await this.cfg().update("project", project, vscode.ConfigurationTarget.Global);
    this.emit();
  }

  appUrl(path = ""): string {
    const base = (this.cfg().get<string>("appUrl") || "https://app.labwired.com").replace(
      /\/$/,
      ""
    );
    return path ? `${base}/${path.replace(/^\//, "")}` : base;
  }
}
