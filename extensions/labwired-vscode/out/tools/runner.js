"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRunner = void 0;
const registry_1 = require("./registry");
class ToolRunner {
    bridge;
    catalog;
    datasheets;
    debug;
    billing;
    constructor(bridge, catalog, datasheets, debug, billing) {
        this.bridge = bridge;
        this.catalog = catalog;
        this.datasheets = datasheets;
        this.debug = debug;
        this.billing = billing;
    }
    listCatalog() {
        return (0, registry_1.toolsHelpText)();
    }
    async runNamed(name, params = {}) {
        if (name === "help" || name === "tools") {
            return ok("help", "Help", ["help"], (0, registry_1.toolsHelpText)());
        }
        if (name === "catalog_search") {
            const q = params.query || "";
            if (!this.catalog)
                return err(name, "Catalog not loaded");
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
            if (!this.datasheets)
                return err(name, "Datasheet service missing");
            try {
                if (name === "datasheet_list") {
                    this.datasheets.ensureDirs();
                    const src = this.datasheets.listSources();
                    const { docs, errors } = this.datasheets.extractAll(false);
                    return ok(name, "Datasheet list", ["datasheet", "list"], [
                        `Folder: .labwired/datasheets/ (${src.length} files)`,
                        ...src.map((s) => `  ${s.name}`),
                        "",
                        "Extracted:",
                        ...docs.map((d) => `  ${d.id}: ${d.chars} chars, ~${d.pagesApprox} pages, ${d.sections.length} sections`),
                        ...(errors.length ? ["", "Errors:", ...errors] : []),
                        "",
                        this.datasheets.agentBrief(),
                    ].join("\n"));
                }
                if (name === "datasheet_extract") {
                    const { docs, errors } = this.datasheets.extractAll(true);
                    return ok(name, "Datasheet extract", ["datasheet", "extract"], [
                        `Extracted ${docs.length} document(s)`,
                        ...docs.map((d) => `  ${d.id}: ${d.chars} chars`),
                        ...(errors.length ? ["Errors:", ...errors] : []),
                    ].join("\n"));
                }
                if (name === "datasheet_grep") {
                    const out = this.datasheets.grep(params.pattern || "");
                    return ok(name, "Datasheet grep", ["datasheet", "grep"], out);
                }
                if (name === "datasheet_section") {
                    const out = this.datasheets.readSection(params.id || "", params.section || "");
                    return ok(name, "Datasheet section", ["datasheet", "section"], out);
                }
            }
            catch (e) {
                return err(name, String(e));
            }
        }
        // —— debug / GDB ——
        if (name.startsWith("debug_")) {
            if (!this.debug)
                return err(name, "Debug service missing");
            try {
                if (name === "debug_info") {
                    return ok(name, "Debug info", ["gdb", "info"], this.debug.info(params.chip));
                }
                if (name === "debug_gdb_start") {
                    return ok(name, "GDB start", ["gdb", "start", params.chip], this.debug.startGdbServer(params.chip, Number(params.port) || 1337));
                }
                if (name === "debug_gdb_stop") {
                    return ok(name, "GDB stop", ["gdb", "stop"], this.debug.stopGdbServer());
                }
                if (name === "debug_read") {
                    return ok(name, "Read mem", ["gdb", "read"], this.debug.readMem(params.chip, params.address, Number(params.words) || 4));
                }
                if (name === "debug_rtt") {
                    return ok(name, "RTT", ["rtt", params.chip], this.debug.startRtt(params.chip));
                }
            }
            catch (e) {
                return err(name, String(e));
            }
        }
        if (name === "billing_status") {
            if (!this.billing)
                return err(name, "Billing service missing");
            const s = await this.billing.status();
            return ok(name, "Billing", ["billing"], this.billing.formatStatus(s));
        }
        const tool = (0, registry_1.getTool)(name);
        if (!tool) {
            return err(name, `Unknown tool: ${name}\n\n${(0, registry_1.toolsHelpText)()}`);
        }
        for (const p of tool.params || []) {
            if (p.required && !(params[p.name] || p.default)) {
                return err(name, `Missing param: ${p.name} — ${p.description}`);
            }
        }
        if (tool.argv[0]?.startsWith("__")) {
            return err(name, "Internal tool not handled in runner");
        }
        const argv = (0, registry_1.resolveArgv)(tool, params).filter((a) => a !== "");
        return this.exec(tool, argv);
    }
    async tryRoute(message) {
        const route = (0, registry_1.routeMessage)(message);
        if (!route)
            return null;
        return this.runNamed(route.tool, route.params);
    }
    async exec(tool, argv) {
        await this.bridge.ensureCli();
        const r = await this.bridge.run(argv, {
            timeoutMs: tool.timeoutMs ?? 120_000,
        });
        const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim() || "(no output)";
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
exports.ToolRunner = ToolRunner;
function ok(tool, title, argv, output) {
    return { tool, title, argv, status: "ok", output, code: 0 };
}
function err(tool, output) {
    return {
        tool,
        title: tool,
        argv: [],
        status: "error",
        output,
        code: 1,
    };
}
//# sourceMappingURL=runner.js.map