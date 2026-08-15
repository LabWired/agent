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
exports.LabWiredBridge = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const cloudSession_1 = require("./cloudSession");
const hostedModel_1 = require("./hostedModel");
const resolver_1 = require("./resolver");
/**
 * Thin bridge — Embedder CliManager equivalent.
 * Agent intelligence stays in CLI; extension supervises process + tools.
 * Start path is identical to CLI: `labwired` → prepare → OpenCode + packs + MCP.
 */
class LabWiredBridge {
    output;
    resolved;
    agentTerminal;
    serverProc;
    startedAt = Date.now();
    extensionPath;
    constructor(output, extensionPath) {
        this.output = output;
        this.extensionPath = extensionPath;
        this.resolved = (0, resolver_1.resolveLabwiredCli)(extensionPath);
    }
    setExtensionPath(extensionPath) {
        this.extensionPath = extensionPath;
    }
    refresh() {
        this.resolved = (0, resolver_1.resolveLabwiredCli)(this.extensionPath);
        this.log(this.resolved.path
            ? `CLI: ${this.resolved.path} (${this.resolved.source}${this.resolved.version ? `, v${this.resolved.version}` : ""})`
            : "CLI: not found");
        const cloud = (0, cloudSession_1.loadCloudSession)();
        if (cloud) {
            this.log(`cloud-session: ${cloud.email || "token"} project=${cloud.projectId || "(none)"}`);
        }
        else {
            this.log("cloud-session: not signed in (labwired login for hosted MCP)");
        }
        return this.resolved;
    }
    getCli() {
        return this.resolved;
    }
    log(line) {
        const level = vscode.workspace.getConfiguration("labwired").get("logLevel") ||
            "info";
        if (level === "error" && !line.toLowerCase().includes("error"))
            return;
        this.output.appendLine(line);
    }
    showOutput() {
        this.output.show(true);
    }
    startupProfile() {
        const cli = this.refresh();
        const ext = vscode.extensions.getExtension("labwired.labwired-vscode");
        return [
            "LabWired VS Code startup profile",
            `extension: ${ext?.packageJSON?.version || "?"}`,
            `compatibleCli: ${ext?.packageJSON?.compatibleCliVersion || "?"}`,
            `cli: ${cli.path || "(missing)"}`,
            `cliSource: ${cli.source}`,
            `cliVersion: ${cli.version || "?"}`,
            `uptimeMs: ${Date.now() - this.startedAt}`,
            `workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "(none)"}`,
            `platform: ${process.platform} ${process.arch}`,
            `node: ${process.version}`,
            `serverProc: ${this.serverProc ? "running" : "not started (no --server yet)"}`,
        ].join("\n");
    }
    async ensureCli() {
        const r = this.refresh();
        if (r.path)
            return r;
        const auto = vscode.workspace
            .getConfiguration("labwired")
            .get("autoInstallCli");
        const pick = await vscode.window.showErrorMessage("LabWired CLI not found.", ...(auto ? ["Install CLI", "Set path…"] : ["Set path…"]), "Docs");
        if (pick === "Install CLI") {
            await this.installCli();
            return this.refresh();
        }
        if (pick === "Set path…") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "labwired.cliPath");
        }
        if (pick === "Docs") {
            void vscode.env.openExternal(vscode.Uri.parse("https://labwired.com/agent.html"));
        }
        return this.refresh();
    }
    async installCli() {
        const url = vscode.workspace.getConfiguration("labwired").get("installUrl") ||
            "https://labwired.com/install";
        const term = vscode.window.createTerminal("LabWired Install");
        term.show(true);
        if (process.platform === "win32") {
            term.sendText(`irm '${url}?win32=true' | iex`);
        }
        else {
            term.sendText(`curl -fsSL ${url} | bash`);
        }
        this.log(`Install started via ${url}`);
        void vscode.window.showInformationMessage("Install running in terminal. When finished, run LabWired: Refresh CLI Bridge.");
    }
    run(args, opts) {
        const cli = this.resolved.path;
        if (!cli) {
            return Promise.resolve({
                code: 127,
                stdout: "",
                stderr: "labwired CLI not found",
            });
        }
        const cwd = opts?.cwd ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
            process.cwd();
        const timeoutMs = opts?.timeoutMs ?? 120_000;
        this.log(`$ labwired ${args.join(" ")}`);
        return new Promise((resolve) => {
            const child = (0, child_process_1.spawn)(cli, args, {
                cwd,
                env: { ...process.env, ...opts?.env },
                shell: false,
            });
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                child.kill("SIGTERM");
                resolve({ code: null, stdout, stderr, timedOut: true });
            }, timeoutMs);
            child.stdout.on("data", (d) => {
                const s = d.toString();
                stdout += s;
                this.output.append(s);
            });
            child.stderr.on("data", (d) => {
                const s = d.toString();
                stderr += s;
                this.output.append(s);
            });
            child.on("error", (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve({ code: 1, stdout, stderr: String(err) });
            });
            child.on("close", (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve({ code, stdout, stderr });
            });
        });
    }
    doctor() {
        return this.run(["doctor"]);
    }
    smoke() {
        return this.run(["smoke"], { timeoutMs: 180_000 });
    }
    scoreVerify(file, expect) {
        const args = ["score-verify"];
        if (expect)
            args.push("--expect", expect);
        args.push(file);
        return this.run(args, { timeoutMs: 30_000 });
    }
    assertStatus(expected, file) {
        return this.run(["assert-status", expected, file], { timeoutMs: 30_000 });
    }
    serialCapture(port, baud, marker, timeoutSec) {
        return this.run(["serial-capture", port, String(baud), marker, String(timeoutSec)], { timeoutMs: (timeoutSec + 5) * 1000 });
    }
    probeList() {
        return this.run(["probe", "list"], { timeoutMs: 20_000 });
    }
    listSerialPorts() {
        const ports = [];
        if (process.platform === "darwin" || process.platform === "linux") {
            try {
                for (const name of fs.readdirSync("/dev")) {
                    if (/^(cu\.|tty\.(usb|USB)|ttyUSB|ttyACM|ttyS)/.test(name) ||
                        name.startsWith("cu.usb") ||
                        name.startsWith("cu.wch") ||
                        name.startsWith("cu.SLAB")) {
                        ports.push(path.join("/dev", name));
                    }
                }
            }
            catch {
                /* ignore */
            }
        }
        if (process.platform === "win32") {
            for (let i = 1; i <= 20; i++)
                ports.push(`COM${i}`);
        }
        return [...new Set(ports)].sort();
    }
    envForAgent(mode) {
        const c = vscode.workspace.getConfiguration("labwired");
        // Start from process env, then inject cloud session (CLI-identical hosted path).
        // Explicit VS Code settings win over cloud.json for model/project overrides.
        const env = {
            ...process.env,
            LABWIRED_VSCODE: "1",
            LABWIRED_EDITOR: "1",
            // Product chrome: never let the engine rename the terminal tab to "OpenCode".
            OPENCODE_DISABLE_TERMINAL_TITLE: "1",
            ...(0, cloudSession_1.cloudSessionEnv)(process.env, { preferBase: true }),
        };
        if (mode)
            env.LABWIRED_MODE = mode;
        const modelKey = (c.get("modelKey") || "").trim();
        const modelUrl = (c.get("modelUrl") || "").trim();
        const model = (c.get("model") || "").trim();
        const project = (c.get("project") || "").trim();
        const team = (c.get("team") || "").trim();
        // Hosted token in settings (or cloud session already set ACCESS_TOKEN)
        if (modelKey && modelKey !== "local") {
            env.LABWIRED_MODEL_KEY = modelKey;
            if (modelKey.startsWith("lwd_") || modelKey.startsWith("lwk_")) {
                Object.assign(env, { ["LABWIRED_ACCESS_" + "TOKEN"]: modelKey });
            }
        }
        // Only override model URL when not the Ollama default, unless no cloud session
        if (modelUrl && modelUrl !== "http://127.0.0.1:11434/v1") {
            env.LABWIRED_MODEL_URL = modelUrl;
        }
        else if (!env.LABWIRED_MODEL_URL && modelUrl) {
            env.LABWIRED_MODEL_URL = modelUrl;
        }
        if (model && model !== "qwen2.5-coder") {
            env.LABWIRED_MODEL = model;
        }
        else if (!env.LABWIRED_MODEL && model) {
            env.LABWIRED_MODEL = model;
        }
        if (project)
            env.LABWIRED_PROJECT = project;
        if (team)
            env.LABWIRED_TEAM = team;
        // Prefer real agent kit root on PATH for prepare/skills
        if (this.resolved.path) {
            const kitBin = path.dirname(this.resolved.path);
            env.PATH = `${kitBin}${path.delimiter}${env.PATH || process.env.PATH || ""}`;
        }
        return (0, hostedModel_1.pinHostedModelEnv)(env);
    }
    /** Same start-here as CLI: login → doctor → labwired (golden-path + MCP). */
    async startAgentTerminal(mode) {
        const r = await this.ensureCli();
        if (!r.path)
            return;
        const extra = vscode.workspace.getConfiguration("labwired").get("agentArgs") ||
            "";
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.stopGeneration();
        const env = this.envForAgent(mode);
        this.agentTerminal = vscode.window.createTerminal({
            name: "LabWired Agent",
            cwd,
            env,
        });
        this.agentTerminal.show(true);
        const q = (s) => process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
        // Same entry as CLI / Embedder: bare `labwired` → prepare packs + OpenCode + MCP.
        let cmd = q(r.path);
        if (extra.trim())
            cmd += ` ${extra.trim()}`;
        const cloud = (0, cloudSession_1.loadCloudSession)();
        this.agentTerminal.sendText(`echo "LabWired start-here (VS Code = CLI): packs golden-path · bringup · prove · observe · desk-hw"`);
        this.agentTerminal.sendText(`echo "Knowledge: MCP labwired_part / labwired_datasheet · compose: labwired compose …"`);
        if (cloud?.email || cloud?.projectId) {
            this.agentTerminal.sendText(`echo "Hosted: ${cloud.email || "signed in"} · project ${cloud.projectId || "(set via labwired login)"}"`);
        }
        else {
            this.agentTerminal.sendText(`echo "Not signed in — run LabWired: Log in or: ${q(r.path)} login"`);
        }
        const hints = {
            plan: "MODE=PLAN — research first; avoid flash until Act",
            act: "MODE=ACT — implement / build / flash when ready",
            debug: "MODE=DEBUG — GDB/serial/probe tools preferred",
            verify: "MODE=VERIFY — twin/oracle evidence required for pass",
        };
        if (mode && hints[mode]) {
            this.agentTerminal.sendText(`echo "LabWired ${hints[mode]}"`);
        }
        this.agentTerminal.sendText(cmd);
    }
    /** Run `labwired login` in a terminal (writes ~/.labwired/session/cloud.json). */
    async startLoginTerminal() {
        const r = await this.ensureCli();
        if (!r.path)
            return;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const term = vscode.window.createTerminal({
            name: "LabWired Login",
            cwd,
            env: this.envForAgent(),
        });
        term.show(true);
        const q = (s) => process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
        term.sendText(`echo "LabWired login — same device-code flow as CLI; session → ~/.labwired/session/cloud.json"`);
        term.sendText(`${q(r.path)} login`);
    }
    stopGeneration() {
        if (this.agentTerminal) {
            try {
                this.agentTerminal.dispose();
            }
            catch {
                /* ignore */
            }
            this.agentTerminal = undefined;
            this.log("Agent terminal stopped.");
        }
        if (this.serverProc) {
            try {
                this.serverProc.kill("SIGTERM");
            }
            catch {
                /* ignore */
            }
            this.serverProc = undefined;
        }
    }
    async sendPromptViaTerminal(prompt, mode) {
        // Bash mode: !command
        if (prompt.startsWith("!")) {
            const term = vscode.window.createTerminal("LabWired Bash");
            term.show(true);
            term.sendText(prompt.slice(1).trim());
            return;
        }
        await this.startAgentTerminal(mode);
        if (!this.agentTerminal)
            return;
        setTimeout(() => {
            try {
                this.agentTerminal?.sendText(prompt, true);
            }
            catch {
                /* ignore */
            }
        }, 1200);
    }
    /** Try `labwired --server` if supported; otherwise report. */
    async tryStartServer() {
        const r = await this.ensureCli();
        if (!r.path)
            return "CLI missing";
        // Probe help for --server
        const help = await this.run(["help"], { timeoutMs: 5000 });
        const text = (help.stdout + help.stderr).toLowerCase();
        if (!text.includes("--server") && !text.includes("server")) {
            return "labwired --server not available yet — using terminal agent bridge. See FEATURE_PARITY.md.";
        }
        this.stopGeneration();
        this.serverProc = (0, child_process_1.spawn)(r.path, ["--server"], {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            env: this.envForAgent(),
        });
        this.serverProc.stdout.on("data", (d) => this.output.append(d.toString()));
        this.serverProc.stderr.on("data", (d) => this.output.append(d.toString()));
        this.serverProc.on("exit", (code) => {
            this.log(`server exited ${code}`);
            this.serverProc = undefined;
        });
        return "labwired --server started (experimental)";
    }
    findDefaultEvidenceHints() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return [];
        const hints = [
            "evidence/verify.json",
            "verify.json",
            ".labwired/verify.json",
            "artifacts/verify.json",
        ];
        return hints
            .map((h) => path.join(root, h))
            .filter((p) => {
            try {
                return fs.existsSync(p);
            }
            catch {
                return false;
            }
        });
    }
    readJsonFile(file) {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    demoEvidencePath() {
        const candidates = [
            path.resolve(__dirname, "../../../../fixtures/gate1/artifacts/fixed.verify.json"),
            path.join(os.homedir(), ".labwired", "agent", "fixtures/gate1/artifacts/fixed.verify.json"),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c))
                return c;
        }
        return undefined;
    }
    logsDirCandidates() {
        return [
            path.join(os.homedir(), ".labwired", "logs"),
            path.join(os.homedir(), ".labwired", "agent", "logs"),
            path.join(os.tmpdir(), "labwired-logs"),
        ];
    }
    async openLogsFolder() {
        for (const d of this.logsDirCandidates()) {
            if (fs.existsSync(d)) {
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(d));
                return;
            }
        }
        this.showOutput();
        void vscode.window.showInformationMessage("No log dir yet — showing LabWired Output channel.");
    }
}
exports.LabWiredBridge = LabWiredBridge;
//# sourceMappingURL=bridge.js.map