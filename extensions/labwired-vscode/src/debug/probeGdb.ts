/**
 * Probe / GDB helpers for the agent tool runner.
 * Implementation lives in out/debug/probeGdb.js for packaged builds;
 * this module restores the TypeScript surface for compile.
 */
import { spawnSync } from "child_process";
import * as vscode from "vscode";

export class ProbeDebugService {
  private log = vscode.window.createOutputChannel("LabWired Debug");

  info(chip?: string): string {
    const c = chip || "(auto)";
    const probe =
      process.env.LABWIRED_PROBE_RS ||
      spawnSync("which", ["probe-rs"], { encoding: "utf8" }).stdout?.trim();
    return [
      "LabWired probe debug",
      `chip: ${c}`,
      `probe-rs: ${probe || "(not found — install via labwired probe install-backend)"}`,
      "tools: debug_info | debug_gdb_start | debug_gdb_stop | debug_read | debug_rtt",
    ].join("\n");
  }

  startGdbServer(chip: string, port = 1337): string {
    return `GDB server not auto-started in this build. Use: probe-rs gdb --chip ${chip} --port ${port}`;
  }

  stopGdbServer(): string {
    return "GDB stop: no managed server process in this build.";
  }

  readMem(chip: string, address: string, words = 4): string {
    const probe = process.env.LABWIRED_PROBE_RS || "probe-rs";
    const r = spawnSync(
      probe,
      ["read", "u32", address, "--chip", chip, "--words", String(words)],
      { encoding: "utf8", timeout: 15000 }
    );
    if (r.error) {
      return `readMem failed: ${r.error.message}`;
    }
    return (r.stdout || "") + (r.stderr || "") || `readMem exit ${r.status}`;
  }

  startRtt(chip: string, _elf?: string): string {
    return `RTT: use probe-rs rtt --chip ${chip} (or labwired probe tools).`;
  }
}
