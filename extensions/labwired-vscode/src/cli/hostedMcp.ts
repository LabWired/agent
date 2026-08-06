/**
 * Thin hosted MCP client (JSON-RPC over HTTPS) for twin inspect/run display pulls.
 * Uses the same session as labwired login (cloud.json).
 */
import { loadCloudSession } from "./cloudSession";

export type McpToolResult = {
  ok: boolean;
  raw?: unknown;
  text?: string;
  error?: string;
};

async function postJson(
  url: string,
  token: string,
  body: unknown,
  projectId?: string
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "labwired-vscode/0.6.2",
  };
  if (projectId) headers["X-LabWired-Project"] = projectId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  // SSE style: lines of data: {...}
  if (text.startsWith("event:") || text.includes("\ndata:")) {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            return JSON.parse(payload);
          } catch {
            /* */
          }
        }
      }
    }
  }
  return JSON.parse(text);
}

let rpcId = 1;

/** Call a hosted labwired_* tool; returns parsed tool text content when possible. */
export async function callHostedTool(
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
  const session = loadCloudSession();
  if (!session) {
    return { ok: false, error: "Not signed in — LabWired: Log in first" };
  }
  const url = `${session.apiBase}/mcp`;
  try {
    // initialize (idempotent enough for short-lived clients)
    await postJson(
      url,
      session.accessToken,
      {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "labwired-vscode", version: "0.6.2" },
        },
      },
      session.projectId
    );
    try {
      await postJson(
        url,
        session.accessToken,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        session.projectId
      );
    } catch {
      /* some gateways ignore notifications */
    }

    const resp = (await postJson(
      url,
      session.accessToken,
      {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      session.projectId
    )) as {
      result?: {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      error?: { message?: string };
    };

    if (resp.error) {
      return { ok: false, error: resp.error.message || JSON.stringify(resp.error) };
    }
    const content = resp.result?.content || [];
    const text = content
      .map((c) => c.text || "")
      .filter(Boolean)
      .join("\n");
    let parsed: unknown = resp.result?.structuredContent;
    if (!parsed && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
    }
    if (resp.result?.isError) {
      return {
        ok: false,
        error: text || "tool error",
        raw: parsed,
        text,
      };
    }
    return { ok: true, raw: parsed, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function inspectSnapshot(
  snapshotId: string,
  output: "peripherals" | "full" | "summary" = "peripherals"
): Promise<McpToolResult> {
  return callHostedTool("labwired_inspect", {
    snapshot_id: snapshotId,
    output,
  });
}
