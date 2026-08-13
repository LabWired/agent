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
exports.ConversationStore = void 0;
const vscode = __importStar(require("vscode"));
function id() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
 * Multi-tab history + checkpoints (Embedder chat/history/rewind surface).
 */
class ConversationStore {
    ctx;
    tabs = [];
    activeTabId = "";
    checkpoints = [];
    listeners = new Set();
    constructor(ctx) {
        this.ctx = ctx;
        this.load();
        if (!this.tabs.length)
            this.newTab("Chat 1");
    }
    onChange(cb) {
        this.listeners.add(cb);
        return new vscode.Disposable(() => this.listeners.delete(cb));
    }
    emit() {
        this.persist();
        for (const cb of this.listeners)
            cb();
    }
    load() {
        this.tabs = this.ctx.workspaceState.get("labwired.tabs") || [];
        this.activeTabId =
            this.ctx.workspaceState.get("labwired.activeTab") || "";
        this.checkpoints =
            this.ctx.workspaceState.get("labwired.checkpoints") || [];
        if (this.tabs.length && !this.tabs.find((t) => t.id === this.activeTabId)) {
            this.activeTabId = this.tabs[0].id;
        }
    }
    persist() {
        void this.ctx.workspaceState.update("labwired.tabs", this.tabs);
        void this.ctx.workspaceState.update("labwired.activeTab", this.activeTabId);
        void this.ctx.workspaceState.update("labwired.checkpoints", this.checkpoints.slice(-50));
    }
    listTabs() {
        return this.tabs.map((t) => ({ ...t, messages: [...t.messages] }));
    }
    getActive() {
        let t = this.tabs.find((x) => x.id === this.activeTabId);
        if (!t) {
            t = this.newTab("Chat 1");
        }
        return t;
    }
    setActive(tabId) {
        if (this.tabs.some((t) => t.id === tabId)) {
            this.activeTabId = tabId;
            this.emit();
        }
    }
    newTab(title) {
        const n = this.tabs.length + 1;
        const tab = {
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
    closeActive() {
        if (this.tabs.length <= 1) {
            this.clearActive();
            return;
        }
        const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
        if (i >= 0)
            this.tabs.splice(i, 1);
        this.activeTabId = this.tabs[0]?.id || "";
        if (!this.activeTabId)
            this.newTab();
        this.emit();
    }
    append(role, text) {
        const tab = this.getActive();
        const msg = { id: id(), role, text, at: Date.now() };
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
    /** Persist + notify after a caller mutated a message in place (streamed text).
     *  Streaming updates bypass append() so they do not write workspaceState per
     *  chunk; call this once at the end of a stream to make the text durable. */
    touch() {
        this.emit();
    }
    clearActive() {
        const tab = this.getActive();
        tab.messages = [];
        tab.updatedAt = Date.now();
        this.emit();
    }
    compressActive(keepLast = 8) {
        const tab = this.getActive();
        if (tab.messages.length <= keepLast)
            return;
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
    undoLast() {
        const tab = this.getActive();
        if (!tab.messages.length)
            return false;
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
    checkpoint(label) {
        const tab = this.getActive();
        this.checkpoints.push({
            id: id(),
            tabId: tab.id,
            label,
            at: Date.now(),
            messageCount: tab.messages.length,
            messages: tab.messages.map((m) => ({ ...m })),
        });
        if (this.checkpoints.length > 50)
            this.checkpoints.shift();
        this.persist();
    }
    listCheckpoints() {
        return [...this.checkpoints].reverse();
    }
    restoreCheckpoint(cpId) {
        const cp = this.checkpoints.find((c) => c.id === cpId);
        if (!cp)
            return false;
        let tab = this.tabs.find((t) => t.id === cp.tabId);
        if (!tab) {
            tab = this.newTab(cp.label);
        }
        else {
            this.activeTabId = tab.id;
        }
        tab.messages = cp.messages.map((m) => ({ ...m }));
        tab.updatedAt = Date.now();
        this.emit();
        return true;
    }
    historyList() {
        return this.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            updatedAt: t.updatedAt,
            count: t.messages.length,
        }));
    }
}
exports.ConversationStore = ConversationStore;
//# sourceMappingURL=conversationStore.js.map