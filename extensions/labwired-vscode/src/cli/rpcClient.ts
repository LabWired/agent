import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import * as vscode from "vscode";

type RpcMsg = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

/**
 * Embedder-style thin client: spawns `labwired server` (JSON-RPC stdio).
 */
export class RpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private ready = false;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly agentRoot: string
  ) {
    super();
  }

  isRunning(): boolean {
    return !!this.child && !this.child.killed;
  }

  async start(workspacePath: string): Promise<void> {
    await this.stop();
    // Prefer server bundled inside the VSIX (Embedder ships binary with extension)
    const bundled = path.join(this.agentRoot, "server", "rpc-server.mjs");
    const fromRepo = path.join(
      path.dirname(this.agentRoot),
      "..",
      "server",
      "rpc-server.mjs"
    );
    // agentRoot may be extension path when packaged
    const candidates = [
      path.join(this.agentRoot, "server", "rpc-server.mjs"),
      bundled,
      path.resolve(this.agentRoot, "../../server/rpc-server.mjs"),
      fromRepo,
    ];
    const serverScript = candidates.find((p) => fs.existsSync(p));
    const labwired = this.findLabwired();

    let cmd: string;
    let args: string[];
    if (serverScript) {
      cmd = process.execPath; // node
      args = [serverScript];
    } else if (labwired) {
      cmd = labwired;
      args = ["server", "--rpc-stdio"];
    } else {
      throw new Error(
        "labwired server script not found (expected server/rpc-server.mjs in extension)"
      );
    }

    this.output.appendLine(`RPC: spawn ${cmd} ${args.join(" ")}`);
    this.child = spawn(cmd, args, {
      cwd: workspacePath,
      env: {
        ...process.env,
        LABWIRED_VSCODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stderr.on("data", (d: Buffer) => {
      this.output.append(`[server] ${d.toString()}`);
    });
    this.child.stdout.on("data", (d: Buffer) => this.onData(d));
    this.child.on("exit", (code) => {
      this.output.appendLine(`RPC: server exited ${code}`);
      this.child = null;
      this.ready = false;
      this.emit("exit", code);
    });

    const init = (await this.request("initialize", {
      protocolVersion: "0.5.0",
      workspacePath,
      clientName: "labwired-vscode",
      clientVersion: "0.6.0",
    })) as { protocolVersion?: string; capabilities?: Record<string, unknown> };
    this.output.appendLine(
      `RPC: protocol ${init?.protocolVersion || "?"} caps=${JSON.stringify(init?.capabilities || {})}`
    );
    // Auto-confirm destructive tools from UI unless user disables later
    try {
      await this.request("autoConfirm/set", { enabled: true });
    } catch {
      /* older server */
    }
    this.ready = true;
    this.emit("ready");
  }

  async stop(): Promise<void> {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill("SIGTERM");
      } catch {
        /* */
      }
      this.child = null;
    }
    this.ready = false;
    for (const [, p] of this.pending) {
      p.reject(new Error("server stopped"));
    }
    this.pending.clear();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.child) throw new Error("RPC not started");
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 600_000);
    });
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      const end = start + len;
      if (this.buf.length < end) break;
      const body = this.buf.subarray(start, end).toString("utf8");
      this.buf = this.buf.subarray(end);
      try {
        const msg = JSON.parse(body) as RpcMsg;
        if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (p) {
            if (msg.error) {
              const err = new Error(msg.error.message) as Error & {
                code?: number;
              };
              err.code = msg.error.code;
              p.reject(err);
            } else p.resolve(msg.result);
          }
        } else if (msg.method) {
          this.emit("notification", msg.method, msg.params || {});
        }
      } catch {
        /* ignore */
      }
    }
  }

  private findLabwired(): string | null {
    const candidates = [
      path.join(this.agentRoot, "bin", "labwired"),
      path.join(process.env.HOME || "", ".labwired", "bin", "labwired"),
      path.join(process.env.HOME || "", ".local", "bin", "labwired"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
}

/** Resolve root that contains server/ (extension install dir or agent repo). */
export function resolveAgentRoot(extensionPath: string): string {
  // Packaged VSIX: server/ is next to package.json (extension root)
  if (fs.existsSync(path.join(extensionPath, "server", "rpc-server.mjs"))) {
    return extensionPath;
  }
  // Dev: extensions/labwired-vscode → agent root ../..
  const cand = path.resolve(extensionPath, "../..");
  if (fs.existsSync(path.join(cand, "server", "rpc-server.mjs"))) return cand;
  if (fs.existsSync(path.join(cand, "bin", "labwired"))) return cand;
  const home = path.join(process.env.HOME || "", ".labwired", "agent");
  if (fs.existsSync(path.join(home, "server", "rpc-server.mjs"))) return home;
  return extensionPath;
}
