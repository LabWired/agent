import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type CatalogPeripheral = {
  device_type: string;
  label: string;
  transport: string;
  summary: string | null;
  kit: boolean;
};

export type CatalogPart = {
  type: string;
  deviceClass: string;
  label: string;
  transport: string;
  pins?: { name: string; etype: string; role?: string }[];
  defaultI2cAddress?: number;
  operatingVoltage?: { min: number; max: number };
};

export type CatalogFacts = {
  schema_version: number;
  device_types: string[];
  peripheral_device_types: string[];
  peripherals: CatalogPeripheral[];
  parts: CatalogPart[];
  chips: string[];
};

export type CatalogHit = {
  kind: "part" | "peripheral" | "chip" | "datasheet";
  id: string;
  label: string;
  score: number;
  detail: string;
  raw?: unknown;
};

/**
 * Local platform/peripheral catalog + project datasheet folder.
 * Embedder-style grounding without their cloud — uses LabWired catalog facts.
 */
export class CatalogService {
  private facts: CatalogFacts | null = null;
  private readonly factsPath: string;

  constructor(private readonly extUri: vscode.Uri) {
    this.factsPath = path.join(extUri.fsPath, "data", "catalog-facts.json");
  }

  load(): CatalogFacts {
    if (this.facts) return this.facts;
    const raw = fs.readFileSync(this.factsPath, "utf8");
    this.facts = JSON.parse(raw) as CatalogFacts;
    return this.facts;
  }

  stats(): { parts: number; peripherals: number; chips: number } {
    const f = this.load();
    return {
      parts: f.parts.length,
      peripherals: f.peripherals.length,
      chips: f.chips.length,
    };
  }

  search(query: string, limit = 20): CatalogHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const f = this.load();
    const hits: CatalogHit[] = [];

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
          detail: `${part.deviceClass} · ${part.transport}${
            part.defaultI2cAddress != null
              ? ` · I2C 0x${part.defaultI2cAddress.toString(16)}`
              : ""
          }`,
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
    const seen = new Set<string>();
    const out: CatalogHit[] = [];
    for (const h of hits) {
      const k = `${h.kind}:${h.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  getPart(type: string): CatalogPart | undefined {
    return this.load().parts.find(
      (p) => p.type.toLowerCase() === type.toLowerCase()
    );
  }

  listProjectDatasheets(): string[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
    const dir = path.join(root, ".labwired", "datasheets");
    try {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => /\.(pdf|md|txt)$/i.test(f))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  ensureDatasheetDir(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    const dir = path.join(root, ".labwired", "datasheets");
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        `# Project datasheets\n\nDrop PDF/MD reference manuals here.\nLabWired indexes filenames for search; full PDF text RAG is incremental.\n\nExample: \`RM0090.pdf\`, \`bme280.pdf\`\n`,
        "utf8"
      );
    }
    return dir;
  }

  /** Context block for LLM freeform prompts (RAG-lite). */
  buildContext(query: string, limit = 8): string {
    const hits = this.search(query, limit);
    const sheets = this.listProjectDatasheets();
    const lines: string[] = [
      "## LabWired hardware catalog (local)",
      `Query: ${query}`,
      "",
    ];
    if (!hits.length) {
      lines.push("No catalog hits. Try chip names (esp32, stm32) or part types (bme280, ssd1306).");
    } else {
      for (const h of hits) {
        lines.push(`- [${h.kind}] ${h.id} — ${h.label}: ${h.detail}`);
        if (h.kind === "part" && h.raw) {
          const p = h.raw as CatalogPart;
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
      for (const s of sheets) lines.push(`- ${path.basename(s)}`);
    } else {
      lines.push(
        "",
        "No project PDFs yet — drop files into .labwired/datasheets/"
      );
    }
    return lines.join("\n");
  }
}
