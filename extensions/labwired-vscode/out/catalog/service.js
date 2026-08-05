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
exports.CatalogService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
/**
 * Local platform/peripheral catalog + project datasheet folder.
 * Embedder-style grounding without their cloud — uses LabWired catalog facts.
 */
class CatalogService {
    extUri;
    facts = null;
    factsPath;
    constructor(extUri) {
        this.extUri = extUri;
        this.factsPath = path.join(extUri.fsPath, "data", "catalog-facts.json");
    }
    load() {
        if (this.facts)
            return this.facts;
        const raw = fs.readFileSync(this.factsPath, "utf8");
        this.facts = JSON.parse(raw);
        return this.facts;
    }
    stats() {
        const f = this.load();
        return {
            parts: f.parts.length,
            peripherals: f.peripherals.length,
            chips: f.chips.length,
        };
    }
    search(query, limit = 20) {
        const q = query.trim().toLowerCase();
        if (!q)
            return [];
        const f = this.load();
        const hits = [];
        for (const chip of f.chips) {
            if (chip.toLowerCase().includes(q)) {
                hits.push({
                    kind: "chip",
                    id: chip,
                    label: chip,
                    score: chip.toLowerCase() === q ? 100 : 50,
                    detail: "MCU / chip family",
                });
            }
        }
        for (const p of f.peripherals) {
            const hay = `${p.device_type} ${p.label} ${p.transport} ${p.summary || ""}`.toLowerCase();
            if (hay.includes(q)) {
                hits.push({
                    kind: "peripheral",
                    id: p.device_type,
                    label: p.label,
                    score: p.device_type.toLowerCase() === q ? 95 : 60,
                    detail: `${p.transport}${p.summary ? " · " + p.summary : ""}`,
                    raw: p,
                });
            }
        }
        for (const part of f.parts) {
            const hay = `${part.type} ${part.label} ${part.deviceClass} ${part.transport}`.toLowerCase();
            if (hay.includes(q)) {
                hits.push({
                    kind: "part",
                    id: part.type,
                    label: part.label,
                    score: part.type.toLowerCase() === q ? 90 : 40,
                    detail: `${part.deviceClass} · ${part.transport}${part.defaultI2cAddress != null
                        ? ` · I2C 0x${part.defaultI2cAddress.toString(16)}`
                        : ""}`,
                    raw: part,
                });
            }
        }
        // Project datasheets
        for (const pdf of this.listProjectDatasheets()) {
            if (pdf.toLowerCase().includes(q) || q === "pdf" || q === "datasheet") {
                hits.push({
                    kind: "datasheet",
                    id: pdf,
                    label: path.basename(pdf),
                    score: 70,
                    detail: pdf,
                });
            }
        }
        hits.sort((a, b) => b.score - a.score);
        // Dedupe by id keeping highest score
        const seen = new Set();
        const out = [];
        for (const h of hits) {
            const k = `${h.kind}:${h.id}`;
            if (seen.has(k))
                continue;
            seen.add(k);
            out.push(h);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    getPart(type) {
        return this.load().parts.find((p) => p.type.toLowerCase() === type.toLowerCase());
    }
    listProjectDatasheets() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return [];
        const dir = path.join(root, ".labwired", "datasheets");
        try {
            if (!fs.existsSync(dir))
                return [];
            return fs
                .readdirSync(dir)
                .filter((f) => /\.(pdf|md|txt)$/i.test(f))
                .map((f) => path.join(dir, f));
        }
        catch {
            return [];
        }
    }
    ensureDatasheetDir() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return undefined;
        const dir = path.join(root, ".labwired", "datasheets");
        fs.mkdirSync(dir, { recursive: true });
        const readme = path.join(dir, "README.md");
        if (!fs.existsSync(readme)) {
            fs.writeFileSync(readme, `# Project datasheets\n\nDrop PDF/MD reference manuals here.\nLabWired indexes filenames for search; full PDF text RAG is incremental.\n\nExample: \`RM0090.pdf\`, \`bme280.pdf\`\n`, "utf8");
        }
        return dir;
    }
    /** Context block for LLM freeform prompts (RAG-lite). */
    buildContext(query, limit = 8) {
        const hits = this.search(query, limit);
        const sheets = this.listProjectDatasheets();
        const lines = [
            "## LabWired hardware catalog (local)",
            `Query: ${query}`,
            "",
        ];
        if (!hits.length) {
            lines.push("No catalog hits. Try chip names (esp32, stm32) or part types (bme280, ssd1306).");
        }
        else {
            for (const h of hits) {
                lines.push(`- [${h.kind}] ${h.id} — ${h.label}: ${h.detail}`);
                if (h.kind === "part" && h.raw) {
                    const p = h.raw;
                    if (p.pins?.length) {
                        const pinStr = p.pins
                            .slice(0, 12)
                            .map((x) => x.name + (x.role ? `(${x.role})` : ""))
                            .join(", ");
                        lines.push(`  pins: ${pinStr}${p.pins.length > 12 ? "…" : ""}`);
                    }
                }
            }
        }
        if (sheets.length) {
            lines.push("", "## Project datasheets (.labwired/datasheets)");
            for (const s of sheets)
                lines.push(`- ${path.basename(s)}`);
        }
        else {
            lines.push("", "No project PDFs yet — drop files into .labwired/datasheets/");
        }
        return lines.join("\n");
    }
}
exports.CatalogService = CatalogService;
//# sourceMappingURL=service.js.map