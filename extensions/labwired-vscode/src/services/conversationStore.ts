import * as vscode from "vscode";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
};

export type ChatTab = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type Checkpoint = {
  id: string;
  tabId: string;
  label: string;
  at: number;
  messageCount: number;
  messages: ChatMessage[];
};

function id(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Multi-tab history + checkpoints (Embedder chat/history/rewind surface).
 */
export class ConversationStore {
  private tabs: ChatTab[] = [];
  private activeTabId = "";
  private checkpoints: Checkpoint[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.load();
    if (!this.tabs.length) this.newTab("Chat 1");
  }

  onChange(cb: () => void): vscode.Disposable {
    this.listeners.add(cb);
    return new vscode.Disposable(() => this.listeners.delete(cb));
  }

  private emit() {
    this.persist();
    for (const cb of this.listeners) cb();
  }

  private load() {
    this.tabs = this.ctx.workspaceState.get<ChatTab[]>("labwired.tabs") || [];
    this.activeTabId =
      this.ctx.workspaceState.get<string>("labwired.activeTab") || "";
    this.checkpoints =
      this.ctx.workspaceState.get<Checkpoint[]>("labwired.checkpoints") || [];
    if (this.tabs.length && !this.tabs.find((t) => t.id === this.activeTabId)) {
      this.activeTabId = this.tabs[0].id;
    }
  }

  private persist() {
    void this.ctx.workspaceState.update("labwired.tabs", this.tabs);
    void this.ctx.workspaceState.update("labwired.activeTab", this.activeTabId);
    void this.ctx.workspaceState.update(
      "labwired.checkpoints",
      this.checkpoints.slice(-50)
    );
  }

  listTabs(): ChatTab[] {
    return this.tabs.map((t) => ({ ...t, messages: [...t.messages] }));
  }

  getActive(): ChatTab {
    let t = this.tabs.find((x) => x.id === this.activeTabId);
    if (!t) {
      t = this.newTab("Chat 1");
    }
    return t;
  }

  setActive(tabId: string) {
    if (this.tabs.some((t) => t.id === tabId)) {
      this.activeTabId = tabId;
      this.emit();
    }
  }

  newTab(title?: string): ChatTab {
    const n = this.tabs.length + 1;
    const tab: ChatTab = {
      id: id(),
      title: title || `Chat ${n}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tabs.unshift(tab);
    this.activeTabId = tab.id;
    this.emit();
    return tab;
  }

  closeActive(): void {
    if (this.tabs.length <= 1) {
      this.clearActive();
      return;
    }
    const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
    if (i >= 0) this.tabs.splice(i, 1);
    this.activeTabId = this.tabs[0]?.id || "";
    if (!this.activeTabId) this.newTab();
    this.emit();
  }

  append(role: ChatRole, text: string): ChatMessage {
    const tab = this.getActive();
    const msg: ChatMessage = { id: id(), role, text, at: Date.now() };
    tab.messages.push(msg);
    tab.updatedAt = Date.now();
    if (role === "user" && tab.messages.filter((m) => m.role === "user").length === 1) {
      tab.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
    }
    // Auto checkpoint after assistant/tool batches
    if (role === "user") {
      this.checkpoint(`before: ${text.slice(0, 32)}`);
    }
    this.emit();
    return msg;
  }

  clearActive() {
    const tab = this.getActive();
    tab.messages = [];
    tab.updatedAt = Date.now();
    this.emit();
  }

  compressActive(keepLast = 8) {
    const tab = this.getActive();
    if (tab.messages.length <= keepLast) return;
    const kept = tab.messages.slice(-keepLast);
    const dropped = tab.messages.length - kept.length;
    tab.messages = [
      {
        id: id(),
        role: "system",
        text: `[compressed] Dropped ${dropped} earlier messages. Full history still in checkpoints when available.`,
        at: Date.now(),
      },
      ...kept,
    ];
    tab.updatedAt = Date.now();
    this.emit();
  }

  undoLast(): boolean {
    const tab = this.getActive();
    if (!tab.messages.length) return false;
    // Prefer restore last checkpoint if undoing user turn
    const cps = this.checkpoints.filter((c) => c.tabId === tab.id);
    if (cps.length) {
      const last = cps[cps.length - 1];
      tab.messages = last.messages.map((m) => ({ ...m }));
      this.checkpoints.pop();
      tab.updatedAt = Date.now();
      this.emit();
      return true;
    }
    tab.messages.pop();
    tab.updatedAt = Date.now();
    this.emit();
    return true;
  }

  checkpoint(label: string) {
    const tab = this.getActive();
    this.checkpoints.push({
      id: id(),
      tabId: tab.id,
      label,
      at: Date.now(),
      messageCount: tab.messages.length,
      messages: tab.messages.map((m) => ({ ...m })),
    });
    if (this.checkpoints.length > 50) this.checkpoints.shift();
    this.persist();
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints].reverse();
  }

  restoreCheckpoint(cpId: string): boolean {
    const cp = this.checkpoints.find((c) => c.id === cpId);
    if (!cp) return false;
    let tab = this.tabs.find((t) => t.id === cp.tabId);
    if (!tab) {
      tab = this.newTab(cp.label);
    } else {
      this.activeTabId = tab.id;
    }
    tab.messages = cp.messages.map((m) => ({ ...m }));
    tab.updatedAt = Date.now();
    this.emit();
    return true;
  }

  historyList(): { id: string; title: string; updatedAt: number; count: number }[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      count: t.messages.length,
    }));
  }
}
