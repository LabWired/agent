import type { LabWiredBridge, RunResult } from "../cli/bridge";
import type { RpcClient } from "../cli/rpcClient";
import type { CatalogService } from "../catalog/service";
import type { DatasheetService } from "../datasheet/agentic";
import type { ProbeDebugService } from "../debug/probeGdb";
import type { BillingService } from "../pro/billing";
import {
  getTool,
  resolveArgv,
  routeMessage,
  toolsHelpText,
  type ToolDef,
} from "./registry";

export type ToolRunEvent = {
  tool: string;
  title: string;
  argv: string[];
  status: "running" | "ok" | "error";
  output: string;
  code: number | null;
};

export class ToolRunner {
  private serverTools: Set<string> | null = null;

  constructor(
    private readonly bridge: LabWiredBridge,
    private readonly catalog?: CatalogService,
    private readonly datasheets?: DatasheetService,
    private readonly debug?: ProbeDebugService,
    private readonly billing?: BillingService,
    private readonly rpc?: RpcClient
  ) {
    // Server restarts may change the exposed tool set — refetch tool/list.
    this.rpc?.on("exit", () => {
      this.serverTools = null;
    });
    this.rpc?.on("ready", () => {
      this.serverTools = null;
    });
  }

  listCatalog(): string {
    return toolsHelpText();
  }

  async runNamed(
    name: string,
    params: Record<string, string> = {}
  ): Promise<ToolRunEvent> {
    if (name === "help" || name === "tools") {
      return ok("help", "Help", ["help"], toolsHelpText());
    }

    if (name === "catalog_search") {
      const q = params.query || "";
      if (!this.catalog) return err(name, "Catalog not loaded");
      const text = this.catalog.buildContext(q, 15);
      const hits = this.catalog.search(q, 15);
      return {
        tool: name,
        title: "Catalog search",
        argv: ["catalog", q],
        status: hits.length ? "ok" : "error",
        output: text,
        code: hits.length ? 0 : 1,
      };
    }

    // —— datasheets (agentic) ——
    if (name.startsWith("datasheet_") || name === "datasheet_list") {
      if (!this.datasheets) return err(name, "Datasheet service missing");
      try {
        if (name === "datasheet_list") {
          this.datasheets.ensureDirs();
          const src = this.datasheets.listSources();
          const { docs, errors } = this.datasheets.extractAll(false);
          return ok(
            name,
            "Datasheet list",
            ["datasheet", "list"],
            [
              `Folder: .labwired/datasheets/ (${src.length} files)`,
              ...src.map((s) => `  ${s.name}`),
              "",
              "Extracted:",
              ...docs.map(
                (d) =>
                  `  ${d.id}: ${d.chars} chars, ~${d.pagesApprox} pages, ${d.sections.length} sections`
              ),
              ...(errors.length ? ["", "Errors:", ...errors] : []),
              "",
              this.datasheets.agentBrief(),
            ].join("\n")
          );
        }
        if (name === "datasheet_extract") {
          const { docs, errors } = this.datasheets.extractAll(true);
          return ok(
            name,
            "Datasheet extract",
            ["datasheet", "extract"],
            [
              `Extracted ${docs.length} document(s)`,
              ...docs.map((d) => `  ${d.id}: ${d.chars} chars`),
              ...(errors.length ? ["Errors:", ...errors] : []),
            ].join("\n")
          );
        }
        if (name === "datasheet_grep") {
          const out = this.datasheets.grep(params.pattern || "");
          return ok(name, "Datasheet grep", ["datasheet", "grep"], out);
        }
        if (name === "datasheet_section") {
          const out = this.datasheets.readSection(
            params.id || "",
            params.section || ""
          );
          return ok(name, "Datasheet section", ["datasheet", "section"], out);
        }
      } catch (e) {
        return err(name, String(e));
      }
    }

    // —— debug / GDB ——
    if (name.startsWith("debug_")) {
      if (!this.debug) return err(name, "Debug service missing");
      try {
        if (name === "debug_info") {
          return ok(
            name,
            "Debug info",
            ["gdb", "info"],
            this.debug.info(params.chip)
          );
        }
        if (name === "debug_gdb_start") {
          return ok(
            name,
            "GDB start",
            ["gdb", "start", params.chip],
            this.debug.startGdbServer(
              params.chip,
              Number(params.port) || 1337
            )
          );
        }
        if (name === "debug_gdb_stop") {
          return ok(name, "GDB stop", ["gdb", "stop"], this.debug.stopGdbServer());
        }
        if (name === "debug_read") {
          return ok(
            name,
            "Read mem",
            ["gdb", "read"],
            this.debug.readMem(
              params.chip,
              params.address,
              Number(params.words) || 4
            )
          );
        }
        if (name === "debug_rtt") {
          return ok(
            name,
            "RTT",
            ["rtt", params.chip],
            this.debug.startRtt(params.chip)
          );
        }
      } catch (e) {
        return err(name, String(e));
      }
    }

    if (name === "billing_status") {
      if (!this.billing) return err(name, "Billing service missing");
      const s = await this.billing.status();
      return ok(name, "Billing", ["billing"], this.billing.formatStatus(s));
    }

    const tool = getTool(name);
    if (!tool) {
      return err(name, `Unknown tool: ${name}\n\n${toolsHelpText()}`);
    }

    for (const p of tool.params || []) {
      if (p.required && !(params[p.name] || p.default)) {
        return err(name, `Missing param: ${p.name} — ${p.description}`);
      }
    }

    if (tool.argv[0]?.startsWith("__")) {
      return err(name, "Internal tool not handled in runner");
    }

    const argv = resolveArgv(tool, params).filter((a) => a !== "");

    // Prefer the running server: plan/verify-mode gates and flash confirm
    // gate live server-side. CLI below stays as explicit fallback.
    if (await this.rpcSupports(name)) {
      try {
        const r = (await this.rpc!.request("tool/run", { name, params })) as {
          name: string;
          code: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          extra?: unknown;
        };
        const output =
          [r.stdout, r.stderr].filter(Boolean).join("\n").trim() ||
          "(no output)";
        return {
          tool: r.name,
          title: tool.title,
          argv,
          status: r.code === 0 ? "ok" : "error",
          output: output.slice(0, 12000),
          code: r.code,
        };
      } catch (e) {
        // Mode gates / confirm gates arrive as JSON-RPC errors — surface honestly.
        const err = e as Error & { code?: number };
        return {
          tool: name,
          title: tool.title,
          argv,
          status: "error",
          output: String(err?.message ?? e),
          code: typeof err?.code === "number" ? err.code : -1,
        };
      }
    }

    return this.exec(tool, argv);
  }

  /** True when the server is up and exposes this tool name (cached tool/list). */
  private async rpcSupports(tool: string): Promise<boolean> {
    if (!this.rpc || !this.rpc.isRunning()) return false;
    if (!this.serverTools) {
      try {
        const res = (await this.rpc.request("tool/list")) as {
          tools: { name: string }[];
        };
        this.serverTools = new Set(res.tools.map((t) => t.name));
      } catch {
        return false;
      }
    }
    return this.serverTools.has(tool);
  }

  async tryRoute(message: string): Promise<ToolRunEvent | null> {
    const route = routeMessage(message);
    if (!route) return null;
    return this.runNamed(route.tool, route.params);
  }

  private async exec(tool: ToolDef, argv: string[]): Promise<ToolRunEvent> {
    await this.bridge.ensureCli();
    const r: RunResult = await this.bridge.run(argv, {
      timeoutMs: tool.timeoutMs ?? 120_000,
    });
    const output =
      [r.stdout, r.stderr].filter(Boolean).join("\n").trim() || "(no output)";
    return {
      tool: tool.name,
      title: tool.title,
      argv,
      status: r.code === 0 ? "ok" : "error",
      output: output.slice(0, 12000),
      code: r.code,
    };
  }
}

function ok(
  tool: string,
  title: string,
  argv: string[],
  output: string
): ToolRunEvent {
  return { tool, title, argv, status: "ok", output, code: 0 };
}
function err(tool: string, output: string): ToolRunEvent {
  return {
    tool,
    title: tool,
    argv: [],
    status: "error",
    output,
    code: 1,
  };
}
