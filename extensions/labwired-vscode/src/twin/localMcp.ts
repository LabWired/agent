/**
 * One-shot local stdio MCP client for digital twin tools.
 * Spawns `npx -y @labwired/mcp` (or LABWIRED_MCP_CMD) — same registry as hosted.
 */
import { spawn } from "child_process";

export type LocalMcpResult = {
  ok: boolean;
  raw?: unknown;
  text?: string;
  error?: string;
};

function parseContent(result: {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}): LocalMcpResult {
  const text = (result.content || [])
    .map((c) => c.text || "")
    .filter(Boolean)
    .join("\n");
  let parsed: unknown = result.structuredContent;
  if (!parsed && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  if (result.isError) {
    return { ok: false, error: text || "tool error", raw: parsed, text };
  }
  return { ok: true, raw: parsed, text };
}

/**
 * Call one tool on local @labwired/mcp via stdio JSON-RPC (Content-Length frames).
 */
export async function callLocalMcpTool(
  name: string,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<LocalMcpResult> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const cmd = process.env.LABWIRED_MCP_CMD || "npx";
  const cmdArgs =
    process.env.LABWIRED_MCP_CMD
      ? []
      : ["-y", "@labwired/mcp"];

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...opts?.env,
        // Prefer local board YAML resolution when monorepo is present
        LABWIRED_REPO_ROOT:
          process.env.LABWIRED_REPO_ROOT ||
          process.env.LABWIRED_CORE_ROOT ||
          "",
      },
    });

    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    let rpcId = 1;
    const pending = new Map<
      number,
      (v: { result?: unknown; error?: { message?: string } }) => void
    >();

    const finish = (r: LocalMcpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* */
      }
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `local MCP timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    const send = (msg: object) => {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      const frame = Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
        body,
      ]);
      child.stdin.write(frame);
    };

    const request = (method: string, params?: unknown) =>
      new Promise<{ result?: unknown; error?: { message?: string } }>(
        (res) => {
          const id = rpcId++;
          pending.set(id, res);
          send({ jsonrpc: "2.0", id, method, params: params ?? {} });
        }
      );

    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = buf.slice(0, headerEnd).toString("utf8");
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          buf = buf.slice(headerEnd + 4);
          continue;
        }
        const len = parseInt(m[1], 10);
        const start = headerEnd + 4;
        if (buf.length < start + len) break;
        const body = buf.slice(start, start + len).toString("utf8");
        buf = buf.slice(start + len);
        try {
          const msg = JSON.parse(body) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
            method?: string;
          };
          if (msg.id != null && pending.has(msg.id)) {
            const cb = pending.get(msg.id)!;
            pending.delete(msg.id);
            cb({ result: msg.result, error: msg.error });
          }
        } catch {
          /* */
        }
      }
    });

    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    child.on("error", (e) => {
      finish({ ok: false, error: `spawn local MCP: ${e.message}` });
    });

    child.on("close", (code) => {
      if (!settled) {
        finish({
          ok: false,
          error: `local MCP exited ${code}: ${stderr.slice(0, 400)}`,
        });
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "labwired-vscode-local", version: "0.10.0" },
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const call = await request("tools/call", {
          name,
          arguments: args,
        });
        if (call.error) {
          finish({
            ok: false,
            error: call.error.message || JSON.stringify(call.error),
          });
          return;
        }
        const result = call.result as {
          content?: { type?: string; text?: string }[];
          isError?: boolean;
          structuredContent?: unknown;
        };
        finish(parseContent(result || {}));
      } catch (e) {
        finish({
          ok: false,
          error: String(e) + (stderr ? ` · ${stderr.slice(0, 200)}` : ""),
        });
      }
    })();
  });
}
