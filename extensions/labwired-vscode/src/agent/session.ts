import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as vscode from "vscode";
import type { CatalogService } from "../catalog/service";
import type { ToolRunner } from "../tools/runner";
import type { AgentMode } from "../services/sessionState";

export type AgentStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "error"; message: string }
  | { type: "done"; source: "opencode" | "openai" | "fallback" };

/**
 * In-panel freeform LLM — no interactive terminal hop.
 *
 * 1) Prefer `opencode run --format json` (full LabWired agent + MCP skills)
 * 2) Fallback: OpenAI-compatible chat at LABWIRED_MODEL_URL with catalog RAG + tools hint
 */
export class AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | undefined;

  constructor(
    private readonly catalog: CatalogService,
    private readonly tools: ToolRunner
  ) {}

  stop() {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }

  async run(
    prompt: string,
    mode: AgentMode,
    onEvent: (e: AgentStreamEvent) => void
  ): Promise<void> {
    this.stop();
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const enriched = this.enrichPrompt(prompt, mode);

    // Try OpenCode first (real agent)
    const oc = await this.tryOpencode(enriched, cwd, mode, onEvent);
    if (oc) return;

    // Direct model API
    const api = await this.tryOpenAI(enriched, mode, onEvent);
    if (api) return;

    onEvent({
      type: "error",
      message:
        "No LLM available. Start Ollama (or set LABWIRED_MODEL_URL / LABWIRED_MODEL_KEY), or fix OpenCode. Tools still work via /doctor /probe …",
    });
    onEvent({ type: "done", source: "fallback" });
  }

  private enrichPrompt(prompt: string, mode: AgentMode): string {
    // Catalog facts + agentic datasheet brief (tools for grep/section — not vector RAG)
    const catalog = this.catalog.buildContext(prompt, 6);
    return [
      `Mode: ${mode}`,
      "You are LabWired firmware agent (VS Code = same path as CLI OpenCode).",
      "Default skill pack: golden-path. Others: bringup · prove · observe · desk-hw (+ Superpowers process).",
      "Never claim model_verified without labwired_verify success. Never invent datasheet facts.",
      "Knowledge MCP only: labwired_part then labwired_datasheet (facts vs quotes; no invent).",
      "Observability: labwired compose (elements) — not ready-made plots.",
      "IDE slash tools: /doctor /smoke /probe /serial /catalog /datasheet grep|section /gdb /rtt /billing /tools",
      "Prefer full terminal agent (LabWired: Start Agent) for twin + MCP; in-panel is a fallback.",
      "",
      catalog,
      "",
      "User request:",
      prompt,
    ].join("\n");
  }

  private tryOpencode(
    prompt: string,
    cwd: string,
    mode: AgentMode,
    onEvent: (e: AgentStreamEvent) => void
  ): Promise<boolean> {
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
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.child = null;
        resolve(ok);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("opencode", args, {
          cwd,
          env,
          shell: false,
        }) as ChildProcessWithoutNullStreams;
      } catch {
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
          } catch {
            /* */
          }
          finish(false);
        }
      }, 12_000);

      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as Record<string, unknown>;
            gotEvent = true;
            clearTimeout(timer);
            this.handleOpencodeEvent(ev, onEvent);
          } catch {
            if (line.trim()) {
              gotEvent = true;
              onEvent({ type: "text", text: line + "\n" });
            }
          }
        }
      });

      child.stderr.on("data", (d: Buffer) => {
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

  private handleOpencodeEvent(
    ev: Record<string, unknown>,
    onEvent: (e: AgentStreamEvent) => void
  ) {
    if (typeof ev.sessionID === "string") this.sessionId = ev.sessionID;
    if (typeof ev.sessionId === "string") this.sessionId = ev.sessionId;

    const type = String(ev.type || "");
    if (type === "error") {
      const err = ev.error as { data?: { message?: string }; message?: string } | string;
      const msg =
        typeof err === "string"
          ? err
          : err?.data?.message || err?.message || JSON.stringify(ev.error);
      onEvent({ type: "error", message: msg });
      return;
    }
    // Common streaming shapes
    if (type === "text" || type === "message.part" || type === "content") {
      const text =
        (ev.text as string) ||
        (ev.delta as string) ||
        (ev.content as string) ||
        "";
      if (text) onEvent({ type: "text", text });
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
      const m = ev.message as { content?: string; text?: string };
      const t = m.content || m.text;
      if (t) onEvent({ type: "text", text: t });
    }
  }

  private async tryOpenAI(
    prompt: string,
    mode: AgentMode,
    onEvent: (e: AgentStreamEvent) => void
  ): Promise<boolean> {
    const base = (
      process.env.LABWIRED_MODEL_URL ||
      vscode.workspace.getConfiguration("labwired").get<string>("modelUrl") ||
      "http://127.0.0.1:11434/v1"
    ).replace(/\/$/, "");
    const key =
      process.env.LABWIRED_MODEL_KEY ||
      vscode.workspace.getConfiguration("labwired").get<string>("modelKey") ||
      "local";
    const model =
      vscode.workspace.getConfiguration("labwired").get<string>("model") ||
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
              content:
                "You are LabWired firmware agent. Use catalog context. Suggest slash tools when hardware checks are needed. Never claim model_verified without verify evidence.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok || !res.body) {
        // non-stream fallback
        if (res.ok) {
          const j = (await res.json()) as {
            choices?: { message?: { content?: string } }[];
          };
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
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const line of parts) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const data = s.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const t = j.choices?.[0]?.delta?.content;
            if (t) {
              any = true;
              onEvent({ type: "text", text: t });
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (!any) return false;
      onEvent({ type: "done", source: "openai" });
      return true;
    } catch {
      return false;
    }
  }
}
