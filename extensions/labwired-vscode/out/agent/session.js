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
exports.AgentSession = void 0;
const child_process_1 = require("child_process");
const vscode = __importStar(require("vscode"));
/**
 * In-panel freeform LLM — no interactive terminal hop.
 *
 * 1) Prefer `opencode run --format json` (full LabWired agent + MCP skills)
 * 2) Fallback: OpenAI-compatible chat at LABWIRED_MODEL_URL with catalog RAG + tools hint
 */
class AgentSession {
    catalog;
    tools;
    child = null;
    sessionId;
    constructor(catalog, tools) {
        this.catalog = catalog;
        this.tools = tools;
    }
    stop() {
        if (this.child) {
            try {
                this.child.kill("SIGTERM");
            }
            catch {
                /* ignore */
            }
            this.child = null;
        }
    }
    async run(prompt, mode, onEvent) {
        this.stop();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const enriched = this.enrichPrompt(prompt, mode);
        // Try OpenCode first (real agent)
        const oc = await this.tryOpencode(enriched, cwd, mode, onEvent);
        if (oc)
            return;
        // Direct model API
        const api = await this.tryOpenAI(enriched, mode, onEvent);
        if (api)
            return;
        onEvent({
            type: "error",
            message: "No LLM available. Start Ollama (or set LABWIRED_MODEL_URL / LABWIRED_MODEL_KEY), or fix OpenCode. Tools still work via /doctor /probe …",
        });
        onEvent({ type: "done", source: "fallback" });
    }
    enrichPrompt(prompt, mode) {
        // Catalog facts + agentic datasheet brief (tools for grep/section — not vector RAG)
        const catalog = this.catalog.buildContext(prompt, 6);
        return [
            `Mode: ${mode}`,
            "You are LabWired firmware agent. Prefer twin verification; never claim model_verified without labwired_verify.",
            "IDE tools: /doctor /smoke /probe /serial /catalog /datasheet grep|section /gdb /rtt /billing /tools",
            "Datasheets: use agentic navigation (list/extract/grep/section) — do NOT invent register maps.",
            "",
            catalog,
            "",
            "User request:",
            prompt,
        ].join("\n");
    }
    tryOpencode(prompt, cwd, mode, onEvent) {
        return new Promise((resolve) => {
            const args = ["run", "--format", "json", "--agent", "labwired"];
            if (this.sessionId) {
                args.push("--session", this.sessionId);
            }
            // auto-approve for IDE path; user can stop generation
            args.push("--auto");
            args.push(prompt);
            const env = {
                ...process.env,
                LABWIRED_MODE: mode,
                LABWIRED_VSCODE: "1",
            };
            let settled = false;
            const finish = (ok) => {
                if (settled)
                    return;
                settled = true;
                this.child = null;
                resolve(ok);
            };
            let child;
            try {
                child = (0, child_process_1.spawn)("opencode", args, {
                    cwd,
                    env,
                    shell: false,
                });
            }
            catch {
                finish(false);
                return;
            }
            this.child = child;
            let buf = "";
            let gotEvent = false;
            const timer = setTimeout(() => {
                if (!gotEvent) {
                    try {
                        child.kill("SIGTERM");
                    }
                    catch {
                        /* */
                    }
                    finish(false);
                }
            }, 12_000);
            child.stdout.on("data", (d) => {
                buf += d.toString("utf8");
                const lines = buf.split("\n");
                buf = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const ev = JSON.parse(line);
                        gotEvent = true;
                        clearTimeout(timer);
                        this.handleOpencodeEvent(ev, onEvent);
                    }
                    catch {
                        if (line.trim()) {
                            gotEvent = true;
                            onEvent({ type: "text", text: line + "\n" });
                        }
                    }
                }
            });
            child.stderr.on("data", (d) => {
                const s = d.toString();
                // ignore boot logs unless error
                if (/error|fail|ENOENT/i.test(s) && !/level=INFO/.test(s)) {
                    // keep going
                }
            });
            child.on("error", () => {
                clearTimeout(timer);
                finish(false);
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                if (!gotEvent) {
                    finish(false);
                    return;
                }
                onEvent({ type: "done", source: "opencode" });
                finish(true);
                if (code && code !== 0 && !gotEvent) {
                    /* handled */
                }
            });
        });
    }
    handleOpencodeEvent(ev, onEvent) {
        if (typeof ev.sessionID === "string")
            this.sessionId = ev.sessionID;
        if (typeof ev.sessionId === "string")
            this.sessionId = ev.sessionId;
        const type = String(ev.type || "");
        if (type === "error") {
            const err = ev.error;
            const msg = typeof err === "string"
                ? err
                : err?.data?.message || err?.message || JSON.stringify(ev.error);
            onEvent({ type: "error", message: msg });
            return;
        }
        // Common streaming shapes
        if (type === "text" || type === "message.part" || type === "content") {
            const text = ev.text ||
                ev.delta ||
                ev.content ||
                "";
            if (text)
                onEvent({ type: "text", text });
            return;
        }
        if (type.includes("tool")) {
            onEvent({
                type: "tool",
                name: String(ev.name || ev.tool || "tool"),
                detail: JSON.stringify(ev).slice(0, 500),
            });
            return;
        }
        // Fallback: assistant message field
        if (ev.message && typeof ev.message === "object") {
            const m = ev.message;
            const t = m.content || m.text;
            if (t)
                onEvent({ type: "text", text: t });
        }
    }
    async tryOpenAI(prompt, mode, onEvent) {
        const base = (process.env.LABWIRED_MODEL_URL ||
            vscode.workspace.getConfiguration("labwired").get("modelUrl") ||
            "http://127.0.0.1:11434/v1").replace(/\/$/, "");
        const key = process.env.LABWIRED_MODEL_KEY ||
            vscode.workspace.getConfiguration("labwired").get("modelKey") ||
            "local";
        const model = vscode.workspace.getConfiguration("labwired").get("model") ||
            "qwen2.5-coder";
        const url = `${base}/chat/completions`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({
                    model,
                    stream: true,
                    messages: [
                        {
                            role: "system",
                            content: "You are LabWired firmware agent. Use catalog context. Suggest slash tools when hardware checks are needed. Never claim model_verified without verify evidence.",
                        },
                        { role: "user", content: prompt },
                    ],
                }),
            });
            if (!res.ok || !res.body) {
                // non-stream fallback
                if (res.ok) {
                    const j = (await res.json());
                    const text = j.choices?.[0]?.message?.content;
                    if (text) {
                        onEvent({ type: "text", text });
                        onEvent({ type: "done", source: "openai" });
                        return true;
                    }
                }
                return false;
            }
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            let any = false;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buf += dec.decode(value, { stream: true });
                const parts = buf.split("\n");
                buf = parts.pop() || "";
                for (const line of parts) {
                    const s = line.trim();
                    if (!s.startsWith("data:"))
                        continue;
                    const data = s.slice(5).trim();
                    if (data === "[DONE]")
                        continue;
                    try {
                        const j = JSON.parse(data);
                        const t = j.choices?.[0]?.delta?.content;
                        if (t) {
                            any = true;
                            onEvent({ type: "text", text: t });
                        }
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            if (!any)
                return false;
            onEvent({ type: "done", source: "openai" });
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.AgentSession = AgentSession;
//# sourceMappingURL=session.js.map