"use strict";
/**
 * Real LabWired tools — same surface as CLI / skills, runnable from the extension.
 * This is the Embedder "tools" layer: agent/UI invokes, results land in chat.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOLS = void 0;
exports.getTool = getTool;
exports.listToolsByGroup = listToolsByGroup;
exports.resolveArgv = resolveArgv;
exports.routeMessage = routeMessage;
exports.toolsHelpText = toolsHelpText;
exports.TOOLS = [
    // —— install / env ——
    {
        name: "doctor",
        title: "Doctor",
        description: "Check CLI, opencode, skills, sim, probe-rs",
        argv: ["doctor"],
        group: "install",
    },
    {
        name: "doctor_strict",
        title: "Doctor (strict)",
        description: "Doctor requiring sim + probe-rs",
        argv: ["doctor", "--strict"],
        group: "install",
    },
    {
        name: "version",
        title: "Version",
        description: "Agent version and home",
        argv: ["version"],
        group: "install",
    },
    {
        name: "smoke",
        title: "Smoke",
        description: "Prove install: claim gate + simulator",
        argv: ["smoke"],
        group: "install",
        timeoutMs: 180_000,
    },
    {
        name: "install_deps",
        title: "Install deps",
        description: "Install sim + probe-rs + platformio into prefix",
        argv: ["install-deps"],
        group: "install",
        timeoutMs: 600_000,
    },
    {
        name: "update",
        title: "Update",
        description: "Self-update agent kit + tools",
        argv: ["update"],
        group: "install",
        timeoutMs: 300_000,
    },
    {
        name: "package_info",
        title: "Package info",
        description: "Portable prefix info",
        argv: ["package", "info"],
        group: "install",
    },
    {
        name: "package_path",
        title: "Package path",
        description: "Print LABWIRED_HOME path",
        argv: ["package", "path"],
        group: "install",
    },
    // —— verify / oracle ——
    {
        name: "score_verify",
        title: "Score verify JSON",
        description: "Score a verify.json / matrix file",
        argv: ["score-verify", "${file}"],
        params: [
            {
                name: "file",
                description: "Path to verify JSON",
                required: true,
            },
        ],
        group: "verify",
    },
    {
        name: "assert_status",
        title: "Assert status",
        description: "Exit 0 if verify JSON status matches expected",
        argv: ["assert-status", "${expected}", "${file}"],
        params: [
            {
                name: "expected",
                description: "Expected status (e.g. model_verified)",
                required: true,
                default: "model_verified",
            },
            { name: "file", description: "Path to verify JSON", required: true },
        ],
        group: "verify",
    },
    // —— hardware ——
    {
        name: "probe_list",
        title: "Probe list",
        description: "List physical probes + virtual LabWired devices",
        argv: ["probe", "list"],
        group: "hardware",
    },
    {
        name: "probe_doctor",
        title: "Probe doctor",
        description: "Probe backend status (probe-rs)",
        argv: ["probe", "doctor"],
        group: "hardware",
    },
    {
        name: "probe_chips",
        title: "Probe chips",
        description: "Search chip names via probe-rs",
        argv: ["probe", "chips", "${query}"],
        params: [
            {
                name: "query",
                description: "Chip search string (e.g. stm32, nrf52)",
                required: true,
                default: "stm32",
            },
        ],
        group: "hardware",
    },
    {
        name: "probe_flash",
        title: "Flash firmware",
        description: "Flash ELF via probe-rs or virtual twin",
        argv: [
            "probe",
            "flash",
            "${elf}",
            "--chip",
            "${chip}",
            "--target",
            "${target}",
        ],
        params: [
            { name: "elf", description: "Path to .elf", required: true },
            {
                name: "chip",
                description: "Chip id (e.g. STM32L476RGTx)",
                required: true,
            },
            {
                name: "target",
                description: "virtual | probe | auto",
                default: "auto",
            },
        ],
        group: "hardware",
        timeoutMs: 120_000,
    },
    {
        name: "probe_reset",
        title: "Reset target",
        description: "Reset MCU via probe or virtual",
        argv: ["probe", "reset", "--chip", "${chip}", "--target", "${target}"],
        params: [
            { name: "chip", description: "Chip id", required: true },
            { name: "target", description: "virtual | probe | auto", default: "auto" },
        ],
        group: "hardware",
    },
    {
        name: "probe_install_backend",
        title: "Install probe-rs",
        description: "Install probe-rs backend",
        argv: ["probe", "install-backend"],
        group: "hardware",
        timeoutMs: 300_000,
    },
    {
        name: "serial_capture",
        title: "Serial capture",
        description: "UART capture until marker or timeout",
        argv: [
            "serial-capture",
            "${port}",
            "${baud}",
            "${marker}",
            "${timeout}",
        ],
        params: [
            { name: "port", description: "Serial port path", required: true },
            { name: "baud", description: "Baud rate", default: "115200" },
            {
                name: "marker",
                description: "String to observe",
                default: "LABWIRED_OK",
            },
            { name: "timeout", description: "Seconds", default: "10" },
        ],
        group: "hardware",
        timeoutMs: 60_000,
    },
    // —— project / help ——
    {
        name: "help",
        title: "Help",
        description: "CLI help text",
        argv: ["help"],
        group: "project",
    },
    // —— catalog / datasheets (extension-local, not always CLI) ——
    {
        name: "catalog_search",
        title: "Catalog search",
        description: "Search LabWired parts/peripherals/chips catalog",
        argv: ["__catalog_search__", "${query}"],
        params: [
            {
                name: "query",
                description: "Search query (e.g. bme280, esp32)",
                required: true,
            },
        ],
        group: "project",
    },
    // —— agentic datasheets (not vector RAG) ——
    {
        name: "datasheet_list",
        title: "Datasheet list",
        description: "List PDFs/MD in .labwired/datasheets",
        argv: ["__datasheet__", "list"],
        group: "project",
    },
    {
        name: "datasheet_extract",
        title: "Datasheet extract",
        description: "Extract text from datasheets via pdftotext (structure-preserving)",
        argv: ["__datasheet__", "extract"],
        group: "project",
    },
    {
        name: "datasheet_grep",
        title: "Datasheet grep",
        description: "Grep extracted datasheet text (agentic nav, not embeddings)",
        argv: ["__datasheet__", "grep", "${pattern}"],
        params: [
            {
                name: "pattern",
                description: "Regex or string (e.g. USART_BRR|baud rate)",
                required: true,
            },
        ],
        group: "project",
    },
    {
        name: "datasheet_section",
        title: "Datasheet section",
        description: "Read a section by title from extracted datasheet",
        argv: ["__datasheet__", "section", "${id}", "${section}"],
        params: [
            { name: "id", description: "Doc id (filename without ext)", required: true },
            {
                name: "section",
                description: "Section title substring",
                required: true,
            },
        ],
        group: "project",
    },
    // —— GDB / probe debug ——
    {
        name: "debug_info",
        title: "Debug info",
        description: "probe-rs list/info + GDB server status",
        argv: ["__debug__", "info"],
        group: "hardware",
    },
    {
        name: "debug_gdb_start",
        title: "GDB server start",
        description: "Start probe-rs GDB server for chip",
        argv: ["__debug__", "gdb_start", "${chip}", "${port}"],
        params: [
            { name: "chip", description: "Chip id", required: true },
            { name: "port", description: "GDB port", default: "1337" },
        ],
        group: "hardware",
    },
    {
        name: "debug_gdb_stop",
        title: "GDB server stop",
        description: "Stop probe-rs GDB server",
        argv: ["__debug__", "gdb_stop"],
        group: "hardware",
    },
    {
        name: "debug_read",
        title: "Read memory",
        description: "probe-rs read address",
        argv: ["__debug__", "read", "${chip}", "${address}", "${words}"],
        params: [
            { name: "chip", required: true, description: "Chip id" },
            { name: "address", required: true, description: "Hex address" },
            { name: "words", default: "4", description: "Word count" },
        ],
        group: "hardware",
    },
    {
        name: "debug_rtt",
        title: "RTT attach",
        description: "probe-rs attach RTT logging",
        argv: ["__debug__", "rtt", "${chip}"],
        params: [{ name: "chip", required: true, description: "Chip id" }],
        group: "hardware",
    },
    {
        name: "billing_status",
        title: "Billing status",
        description: "Pro plan / login status",
        argv: ["__billing__", "status"],
        group: "project",
    },
];
function getTool(name) {
    return exports.TOOLS.find((t) => t.name === name);
}
function listToolsByGroup() {
    const out = {};
    for (const t of exports.TOOLS) {
        (out[t.group] ||= []).push(t);
    }
    return out;
}
/** Resolve argv with ${param} substitution. */
function resolveArgv(tool, params) {
    return tool.argv.map((a) => {
        const m = a.match(/^\$\{([a-zA-Z0-9_]+)\}$/);
        if (!m)
            return a;
        const key = m[1];
        const def = tool.params?.find((p) => p.name === key)?.default;
        const val = params[key] ?? def ?? "";
        return val;
    });
}
/**
 * Map natural language / slash commands → tool invocations.
 * Returns null if this should go to the freeform agent instead.
 */
function routeMessage(text) {
    const raw = text.trim();
    if (!raw)
        return null;
    // Slash commands: /doctor /smoke /probe list /flash ...
    if (raw.startsWith("/")) {
        const body = raw.slice(1).trim();
        const [cmd, ...rest] = body.split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (cmd.toLowerCase()) {
            case "doctor":
                return rest[0] === "--strict" || rest[0] === "strict"
                    ? { tool: "doctor_strict", params: {} }
                    : { tool: "doctor", params: {} };
            case "smoke":
                return { tool: "smoke", params: {} };
            case "version":
                return { tool: "version", params: {} };
            case "update":
                return { tool: "update", params: {} };
            case "install-deps":
            case "install_deps":
                return { tool: "install_deps", params: {} };
            case "help":
            case "tools":
                return { tool: "help", params: {} };
            case "probe":
                if (!rest[0] || rest[0] === "list")
                    return { tool: "probe_list", params: {} };
                if (rest[0] === "doctor")
                    return { tool: "probe_doctor", params: {} };
                if (rest[0] === "chips")
                    return {
                        tool: "probe_chips",
                        params: { query: rest.slice(1).join(" ") || "stm32" },
                    };
                if (rest[0] === "install-backend")
                    return { tool: "probe_install_backend", params: {} };
                if (rest[0] === "flash" && rest[1]) {
                    // /probe flash path.elf --chip X [--target virtual]
                    const elf = rest[1];
                    let chip = "";
                    let target = "auto";
                    for (let i = 2; i < rest.length; i++) {
                        if (rest[i] === "--chip" && rest[i + 1])
                            chip = rest[++i];
                        else if (rest[i] === "--target" && rest[i + 1])
                            target = rest[++i];
                    }
                    if (!chip)
                        return null;
                    return {
                        tool: "probe_flash",
                        params: { elf, chip, target },
                    };
                }
                if (rest[0] === "reset") {
                    let chip = "";
                    let target = "auto";
                    for (let i = 1; i < rest.length; i++) {
                        if (rest[i] === "--chip" && rest[i + 1])
                            chip = rest[++i];
                        else if (rest[i] === "--target" && rest[i + 1])
                            target = rest[++i];
                    }
                    if (!chip)
                        return null;
                    return { tool: "probe_reset", params: { chip, target } };
                }
                return { tool: "probe_list", params: {} };
            case "serial":
            case "serial-capture": {
                // /serial PORT [baud] [marker] [timeout]
                const [port, baud, marker, timeout] = rest;
                if (!port)
                    return null;
                return {
                    tool: "serial_capture",
                    params: {
                        port,
                        baud: baud || "115200",
                        marker: marker || "LABWIRED_OK",
                        timeout: timeout || "10",
                    },
                };
            }
            case "score":
            case "score-verify":
                if (!arg)
                    return null;
                return { tool: "score_verify", params: { file: arg } };
            case "assert":
            case "assert-status": {
                // /assert model_verified path.json
                if (rest.length < 2)
                    return rest[0]
                        ? {
                            tool: "assert_status",
                            params: {
                                expected: "model_verified",
                                file: rest[0],
                            },
                        }
                        : null;
                return {
                    tool: "assert_status",
                    params: { expected: rest[0], file: rest[1] },
                };
            }
            case "package":
                if (rest[0] === "path")
                    return { tool: "package_path", params: {} };
                return { tool: "package_info", params: {} };
            case "catalog":
            case "part":
            case "peripheral":
                return {
                    tool: "catalog_search",
                    params: { query: arg || "esp32" },
                };
            case "datasheet":
            case "ds": {
                const sub = (rest[0] || "list").toLowerCase();
                if (sub === "list")
                    return { tool: "datasheet_list", params: {} };
                if (sub === "extract")
                    return { tool: "datasheet_extract", params: {} };
                if (sub === "grep" && rest[1])
                    return {
                        tool: "datasheet_grep",
                        params: { pattern: rest.slice(1).join(" ") },
                    };
                if (sub === "section" && rest[1] && rest[2])
                    return {
                        tool: "datasheet_section",
                        params: {
                            id: rest[1],
                            section: rest.slice(2).join(" "),
                        },
                    };
                return { tool: "datasheet_list", params: {} };
            }
            case "gdb": {
                const sub = (rest[0] || "info").toLowerCase();
                if (sub === "stop")
                    return { tool: "debug_gdb_stop", params: {} };
                if (sub === "start" && rest[1])
                    return {
                        tool: "debug_gdb_start",
                        params: { chip: rest[1], port: rest[2] || "1337" },
                    };
                if (sub === "read" && rest[1] && rest[2])
                    return {
                        tool: "debug_read",
                        params: {
                            chip: rest[1],
                            address: rest[2],
                            words: rest[3] || "4",
                        },
                    };
                return { tool: "debug_info", params: {} };
            }
            case "rtt":
                if (!rest[0])
                    return null;
                return { tool: "debug_rtt", params: { chip: rest[0] } };
            case "billing":
            case "account":
                return { tool: "billing_status", params: {} };
            default:
                return null;
        }
    }
    // Natural language shortcuts
    const lower = raw.toLowerCase();
    if (/^(run\s+)?doctor(\s+strict)?$/.test(lower))
        return lower.includes("strict")
            ? { tool: "doctor_strict", params: {} }
            : { tool: "doctor", params: {} };
    if (/^(run\s+)?smoke$/.test(lower))
        return { tool: "smoke", params: {} };
    if (/list\s+(probes?|devices?)|probe\s+list|what\s+probes/.test(lower))
        return { tool: "probe_list", params: {} };
    if (/probe\s+doctor|probe\s+backend/.test(lower))
        return { tool: "probe_doctor", params: {} };
    if (/install\s+deps|install\s+sim|install\s+probe/.test(lower))
        return { tool: "install_deps", params: {} };
    return null;
}
function toolsHelpText() {
    const lines = [
        "LabWired tools (slash commands) — real CLI, results in chat:",
        "",
        "  /doctor [/doctor strict]   /smoke   /version   /update",
        "  /install-deps              /package [info|path]   /help",
        "  /probe list | doctor | chips <q> | install-backend",
        "  /probe flash <elf> --chip <id> [--target virtual|probe|auto]",
        "  /probe reset --chip <id> [--target …]",
        "  /serial <port> [baud] [marker] [timeout]",
        "  /score <verify.json>       /assert [status] <verify.json>",
        "  /catalog <query>           Search local parts/chips",
        "  /datasheet list|extract|grep <pat>|section <id> <title>",
        "  /gdb info|start <chip>|stop|read <chip> <addr>",
        "  /rtt <chip>                probe-rs RTT attach",
        "  /billing                   Pro plan / login status",
        "",
        "Datasheets: agentic (pdftotext + grep/section) — NOT vector RAG.",
        "Freeform: in-panel agent. Live serial: Monitor Connect.",
    ];
    return lines.join("\n");
}
//# sourceMappingURL=registry.js.map