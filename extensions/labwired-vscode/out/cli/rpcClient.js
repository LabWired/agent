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
exports.RpcClient = void 0;
exports.resolveAgentRoot = resolveAgentRoot;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const events_1 = require("events");
/**
 * Embedder-style thin client: spawns `labwired server` (JSON-RPC stdio).
 */
class RpcClient extends events_1.EventEmitter {
    output;
    agentRoot;
    child = null;
    buf = Buffer.alloc(0);
    nextId = 1;
    pending = new Map();
    ready = false;
    constructor(output, agentRoot) {
        super();
        this.output = output;
        this.agentRoot = agentRoot;
    }
    isRunning() {
        return !!this.child && !this.child.killed;
    }
    async start(workspacePath) {
        await this.stop();
        // Prefer server bundled inside the VSIX (Embedder ships binary with extension)
        const bundled = path.join(this.agentRoot, "server", "rpc-server.mjs");
        const fromRepo = path.join(path.dirname(this.agentRoot), "..", "server", "rpc-server.mjs");
        // agentRoot may be extension path when packaged
        const candidates = [
            path.join(this.agentRoot, "server", "rpc-server.mjs"),
            bundled,
            path.resolve(this.agentRoot, "../../server/rpc-server.mjs"),
            fromRepo,
        ];
        const serverScript = candidates.find((p) => fs.existsSync(p));
        const labwired = this.findLabwired();
        let cmd;
        let args;
        if (serverScript) {
            cmd = process.execPath; // node
            args = [serverScript];
        }
        else if (labwired) {
            cmd = labwired;
            args = ["server", "--rpc-stdio"];
        }
        else {
            throw new Error("labwired server script not found (expected server/rpc-server.mjs in extension)");
        }
        this.output.appendLine(`RPC: spawn ${cmd} ${args.join(" ")}`);
        this.child = (0, child_process_1.spawn)(cmd, args, {
            cwd: workspacePath,
            env: {
                ...process.env,
                LABWIRED_VSCODE: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stderr.on("data", (d) => {
            this.output.append(`[server] ${d.toString()}`);
        });
        this.child.stdout.on("data", (d) => this.onData(d));
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
        }));
        this.output.appendLine(`RPC: protocol ${init?.protocolVersion || "?"} caps=${JSON.stringify(init?.capabilities || {})}`);
        // Auto-confirm destructive tools from UI unless user disables later
        try {
            await this.request("autoConfirm/set", { enabled: true });
        }
        catch {
            /* older server */
        }
        this.ready = true;
        this.emit("ready");
    }
    async stop() {
        if (this.child) {
            try {
                this.child.stdin.end();
                this.child.kill("SIGTERM");
            }
            catch {
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
    async request(method, params = {}) {
        if (!this.child)
            throw new Error("RPC not started");
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
    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
            const headerEnd = this.buf.indexOf("\r\n\r\n");
            if (headerEnd === -1)
                break;
            const header = this.buf.subarray(0, headerEnd).toString("ascii");
            const m = /content-length:\s*(\d+)/i.exec(header);
            if (!m) {
                this.buf = this.buf.subarray(headerEnd + 4);
                continue;
            }
            const len = Number(m[1]);
            const start = headerEnd + 4;
            const end = start + len;
            if (this.buf.length < end)
                break;
            const body = this.buf.subarray(start, end).toString("utf8");
            this.buf = this.buf.subarray(end);
            try {
                const msg = JSON.parse(body);
                if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
                    const p = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (p) {
                        if (msg.error) {
                            const err = new Error(msg.error.message);
                            err.code = msg.error.code;
                            p.reject(err);
                        }
                        else
                            p.resolve(msg.result);
                    }
                }
                else if (msg.method) {
                    this.emit("notification", msg.method, msg.params || {});
                }
            }
            catch {
                /* ignore */
            }
        }
    }
    findLabwired() {
        const candidates = [
            path.join(this.agentRoot, "bin", "labwired"),
            path.join(process.env.HOME || "", ".labwired", "bin", "labwired"),
            path.join(process.env.HOME || "", ".local", "bin", "labwired"),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c))
                return c;
        }
        return null;
    }
}
exports.RpcClient = RpcClient;
/** Resolve root that contains server/ (extension install dir or agent repo). */
function resolveAgentRoot(extensionPath) {
    // Packaged VSIX: server/ is next to package.json (extension root)
    if (fs.existsSync(path.join(extensionPath, "server", "rpc-server.mjs"))) {
        return extensionPath;
    }
    // Dev: extensions/labwired-vscode → agent root ../..
    const cand = path.resolve(extensionPath, "../..");
    if (fs.existsSync(path.join(cand, "server", "rpc-server.mjs")))
        return cand;
    if (fs.existsSync(path.join(cand, "bin", "labwired")))
        return cand;
    const home = path.join(process.env.HOME || "", ".labwired", "agent");
    if (fs.existsSync(path.join(home, "server", "rpc-server.mjs")))
        return home;
    return extensionPath;
}
//# sourceMappingURL=rpcClient.js.map