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
exports.ProbeDebugService = void 0;
/**
 * Probe / GDB helpers for the agent tool runner.
 * Implementation lives in out/debug/probeGdb.js for packaged builds;
 * this module restores the TypeScript surface for compile.
 */
const child_process_1 = require("child_process");
const vscode = __importStar(require("vscode"));
class ProbeDebugService {
    log = vscode.window.createOutputChannel("LabWired Debug");
    dispose() {
        try {
            this.log.dispose();
        }
        catch {
            /* ignore */
        }
    }
    info(chip) {
        const c = chip || "(auto)";
        const probe = process.env.LABWIRED_PROBE_RS ||
            (0, child_process_1.spawnSync)("which", ["probe-rs"], { encoding: "utf8" }).stdout?.trim();
        return [
            "LabWired probe debug",
            `chip: ${c}`,
            `probe-rs: ${probe || "(not found — install via labwired probe install-backend)"}`,
            "tools: debug_info | debug_gdb_start | debug_gdb_stop | debug_read | debug_rtt",
        ].join("\n");
    }
    startGdbServer(chip, port = 1337) {
        return `GDB server not auto-started in this build. Use: probe-rs gdb --chip ${chip} --port ${port}`;
    }
    stopGdbServer() {
        return "GDB stop: no managed server process in this build.";
    }
    readMem(chip, address, words = 4) {
        const probe = process.env.LABWIRED_PROBE_RS || "probe-rs";
        const r = (0, child_process_1.spawnSync)(probe, ["read", "u32", address, "--chip", chip, "--words", String(words)], { encoding: "utf8", timeout: 15000 });
        if (r.error) {
            return `readMem failed: ${r.error.message}`;
        }
        return (r.stdout || "") + (r.stderr || "") || `readMem exit ${r.status}`;
    }
    startRtt(chip, _elf) {
        return `RTT: use probe-rs rtt --chip ${chip} (or labwired probe tools).`;
    }
}
exports.ProbeDebugService = ProbeDebugService;
//# sourceMappingURL=probeGdb.js.map