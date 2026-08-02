import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { resolveLabwiredCli, type ResolvedCli } from "./resolver";
import type { AgentMode } from "../services/sessionState";

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

/**
 * Thin bridge — Embedder CliManager equivalent.
 * Agent intelligence stays in CLI; extension supervises process + tools.
 */
export class LabWiredBridge {
  private resolved: ResolvedCli;
  private agentTerminal: vscode.Terminal | undefined;
  private serverProc: ChildProcessWithoutNullStreams | undefined;
  private startedAt = Date.now();

  constructor(private readonly output: vscode.OutputChannel) {
    this.resolved = resolveLabwiredCli();
  }

  refresh(): ResolvedCli {
    this.resolved = resolveLabwiredCli();
    this.log(
      this.resolved.path
        ? `CLI: ${this.resolved.path} (${this.resolved.source}${this.resolved.version ? `, v${this.resolved.version}` : ""})`
        : "CLI: not found"
    );
    return this.resolved;
  }

  getCli(): ResolvedCli {
    return this.resolved;
  }

  log(line: string) {
    const level =
      vscode.workspace.getConfiguration("labwired").get<string>("logLevel") ||
      "info";
    if (level === "error" && !line.toLowerCase().includes("error")) return;
    this.output.appendLine(line);
  }

  showOutput() {
    this.output.show(true);
  }

  startupProfile(): string {
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

  async ensureCli(): Promise<ResolvedCli> {
    const r = this.refresh();
    if (r.path) return r;
    const auto = vscode.workspace
      .getConfiguration("labwired")
      .get<boolean>("autoInstallCli");
    const pick = await vscode.window.showErrorMessage(
      "LabWired CLI not found.",
      ...(auto ? (["Install CLI", "Set path…"] as const) : (["Set path…"] as const)),
      "Docs"
    );
    if (pick === "Install CLI") {
      await this.installCli();
      return this.refresh();
    }
    if (pick === "Set path…") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "labwired.cliPath"
      );
    }
    if (pick === "Docs") {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://labwired.com/agent.html")
      );
    }
    return this.refresh();
  }

  async installCli(): Promise<void> {
    const url =
      vscode.workspace.getConfiguration("labwired").get<string>("installUrl") ||
      "https://labwired.com/install";
    const term = vscode.window.createTerminal("LabWired Install");
    term.show(true);
    if (process.platform === "win32") {
      term.sendText(`irm '${url}?win32=true' | iex`);
    } else {
      term.sendText(`curl -fsSL ${url} | bash`);
    }
    this.log(`Install started via ${url}`);
    void vscode.window.showInformationMessage(
      "Install running in terminal. When finished, run LabWired: Refresh CLI Bridge."
    );
  }

  run(
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
  ): Promise<RunResult> {
    const cli = this.resolved.path;
    if (!cli) {
      return Promise.resolve({
        code: 127,
        stdout: "",
        stderr: "labwired CLI not found",
      });
    }
    const cwd =
      opts?.cwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.cwd();
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    this.log(`$ labwired ${args.join(" ")}`);

    return new Promise((resolve) => {
      const child = spawn(cli, args, {
        cwd,
        env: { ...process.env, ...opts?.env },
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        resolve({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        this.output.append(s);
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        this.output.append(s);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: String(err) });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  doctor(): Promise<RunResult> {
    return this.run(["doctor"]);
  }

  smoke(): Promise<RunResult> {
    return this.run(["smoke"], { timeoutMs: 180_000 });
  }

  scoreVerify(file: string, expect?: string): Promise<RunResult> {
    const args = ["score-verify"];
    if (expect) args.push("--expect", expect);
    args.push(file);
    return this.run(args, { timeoutMs: 30_000 });
  }

  assertStatus(expected: string, file: string): Promise<RunResult> {
    return this.run(["assert-status", expected, file], { timeoutMs: 30_000 });
  }

  serialCapture(
    port: string,
    baud: number,
    marker: string,
    timeoutSec: number
  ): Promise<RunResult> {
    return this.run(
      ["serial-capture", port, String(baud), marker, String(timeoutSec)],
      { timeoutMs: (timeoutSec + 5) * 1000 }
    );
  }

  probeList(): Promise<RunResult> {
    return this.run(["probe", "list"], { timeoutMs: 20_000 });
  }

  listSerialPorts(): string[] {
    const ports: string[] = [];
    if (process.platform === "darwin" || process.platform === "linux") {
      try {
        for (const name of fs.readdirSync("/dev")) {
          if (
            /^(cu\.|tty\.(usb|USB)|ttyUSB|ttyACM|ttyS)/.test(name) ||
            name.startsWith("cu.usb") ||
            name.startsWith("cu.wch") ||
            name.startsWith("cu.SLAB")
          ) {
            ports.push(path.join("/dev", name));
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (process.platform === "win32") {
      for (let i = 1; i <= 20; i++) ports.push(`COM${i}`);
    }
    return [...new Set(ports)].sort();
  }

  envForAgent(mode?: AgentMode): NodeJS.ProcessEnv {
    const c = vscode.workspace.getConfiguration("labwired");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LABWIRED_VSCODE: "1",
    };
    if (mode) env.LABWIRED_MODE = mode;
    const model = c.get<string>("model");
    if (model) env.LABWIRED_MODEL = model;
    const team = c.get<string>("team");
    if (team) env.LABWIRED_TEAM = team;
    const project = c.get<string>("project");
    if (project) env.LABWIRED_PROJECT = project;
    return env;
  }

  async startAgentTerminal(mode?: AgentMode): Promise<void> {
    const r = await this.ensureCli();
    if (!r.path) return;

    const extra =
      vscode.workspace.getConfiguration("labwired").get<string>("agentArgs") ||
      "";
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.stopGeneration();

    this.agentTerminal = vscode.window.createTerminal({
      name: "LabWired Agent",
      cwd,
      env: this.envForAgent(mode),
    });
    this.agentTerminal.show(true);

    const q = (s: string) =>
      process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
    let cmd = q(r.path);
    if (extra.trim()) cmd += ` ${extra.trim()}`;

    const hints: Record<string, string> = {
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

  stopGeneration() {
    if (this.agentTerminal) {
      try {
        this.agentTerminal.dispose();
      } catch {
        /* ignore */
      }
      this.agentTerminal = undefined;
      this.log("Agent terminal stopped.");
    }
    if (this.serverProc) {
      try {
        this.serverProc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.serverProc = undefined;
    }
  }

  async sendPromptViaTerminal(prompt: string, mode: AgentMode): Promise<void> {
    // Bash mode: !command
    if (prompt.startsWith("!")) {
      const term = vscode.window.createTerminal("LabWired Bash");
      term.show(true);
      term.sendText(prompt.slice(1).trim());
      return;
    }
    await this.startAgentTerminal(mode);
    if (!this.agentTerminal) return;
    setTimeout(() => {
      try {
        this.agentTerminal?.sendText(prompt, true);
      } catch {
        /* ignore */
      }
    }, 1200);
  }

  /** Try `labwired --server` if supported; otherwise report. */
  async tryStartServer(): Promise<string> {
    const r = await this.ensureCli();
    if (!r.path) return "CLI missing";
    // Probe help for --server
    const help = await this.run(["help"], { timeoutMs: 5000 });
    const text = (help.stdout + help.stderr).toLowerCase();
    if (!text.includes("--server") && !text.includes("server")) {
      return "labwired --server not available yet — using terminal agent bridge. See FEATURE_PARITY.md.";
    }
    this.stopGeneration();
    this.serverProc = spawn(r.path, ["--server"], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: this.envForAgent(),
    }) as ChildProcessWithoutNullStreams;
    this.serverProc.stdout.on("data", (d) => this.output.append(d.toString()));
    this.serverProc.stderr.on("data", (d) => this.output.append(d.toString()));
    this.serverProc.on("exit", (code) => {
      this.log(`server exited ${code}`);
      this.serverProc = undefined;
    });
    return "labwired --server started (experimental)";
  }

  findDefaultEvidenceHints(): string[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
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
        } catch {
          return false;
        }
      });
  }

  readJsonFile(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  demoEvidencePath(): string | undefined {
    const candidates = [
      path.resolve(
        __dirname,
        "../../../../fixtures/gate1/artifacts/fixed.verify.json"
      ),
      path.join(
        os.homedir(),
        ".labwired",
        "agent",
        "fixtures/gate1/artifacts/fixed.verify.json"
      ),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return undefined;
  }

  logsDirCandidates(): string[] {
    return [
      path.join(os.homedir(), ".labwired", "logs"),
      path.join(os.homedir(), ".labwired", "agent", "logs"),
      path.join(os.tmpdir(), "labwired-logs"),
    ];
  }

  async openLogsFolder(): Promise<void> {
    for (const d of this.logsDirCandidates()) {
      if (fs.existsSync(d)) {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(d)
        );
        return;
      }
    }
    this.showOutput();
    void vscode.window.showInformationMessage(
      "No log dir yet — showing LabWired Output channel."
    );
  }
}
