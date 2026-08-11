/**
 * Multi-source circuit/board import → .labwired/ artifacts + optional twin mint.
 * Sources: PDF, KiCad, netlist, diagram.json, images, BOM CSV, free text.
 */
import * as fs from "fs";
import * as path from "path";
import {
  extractPdfText,
  matchCatalogInText,
  type CatalogHit,
  type PdfImportKind,
} from "./pdfImport";
import type { CatalogBoard } from "./catalogBoards";
import {
  buildStarterDiagram,
  type StarterPreset,
} from "./catalogBoards";
import {
  mintFromDiagramObject,
  mintFromFile,
  type BoardMintResult,
  type CatalogLookup,
} from "./boardMint";
import {
  graphFromHints,
  mergeGraphs,
  parseSpiceNetlist,
  type CircuitGraph,
} from "./netlistGraph";
import {
  bomMapsToHits,
  mapBomRows,
  parseBomCsv,
  type BomMapResult,
} from "./bomMapper";
import {
  coverageFromMapping,
  graphToDiagram,
} from "./graphToDiagram";
import { buildWorkspaceContext } from "./workspaceContext";

export type ImportSourceKind =
  | "pdf-schematic"
  | "pdf-datasheet"
  | "kicad-sch"
  | "kicad-pcb"
  | "netlist"
  | "diagram-json"
  | "image"
  | "bom-csv"
  | "text"
  | "unknown";

export type MultiImportResult = {
  ok: boolean;
  sourceKind: ImportSourceKind;
  sourcePath: string;
  destPath: string;
  textPath?: string;
  hits: CatalogHit[];
  suggestedBoardId?: string;
  minted?: BoardMintResult;
  agentPrompt: string;
  summary: string;
  error?: string;
  /** Freeform notes from the user (MCU, goals, constraints). */
  userContext?: string;
};

function safeBase(filePath: string): string {
  return (
    path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) ||
    "import"
  );
}

function copyInto(
  workspaceRoot: string,
  subdir: string,
  sourcePath: string
): string {
  const dir = path.join(workspaceRoot, ".labwired", subdir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(sourcePath));
  if (path.resolve(sourcePath) !== path.resolve(dest)) {
    fs.copyFileSync(sourcePath, dest);
  }
  return dest;
}

function writeText(
  workspaceRoot: string,
  name: string,
  text: string
): string {
  const dir = path.join(workspaceRoot, ".labwired", "import");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, "utf8");
  return p;
}

function detectKind(filePath: string, force?: ImportSourceKind): ImportSourceKind {
  if (force && force !== "unknown") return force;
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf-schematic"; // default; UI can override datasheet
  if (ext === ".kicad_sch") return "kicad-sch";
  if (ext === ".kicad_pcb" || ext === ".kicad_pro") return "kicad-pcb";
  if (ext === ".net" || ext === ".cir" || ext === ".sp" || base.endsWith(".netlist"))
    return "netlist";
  if (ext === ".json" || base === "diagram.json") return "diagram-json";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"].includes(ext))
    return "image";
  if (ext === ".csv") return "bom-csv";
  if ([".txt", ".md", ".log"].includes(ext)) return "text";
  return "unknown";
}

/** Extract lib_id / Value / Reference from KiCad s-expr schematic (best-effort). */
export function parseKicadSchHints(content: string): string[] {
  const hints: string[] = [];
  const libIds = content.matchAll(/\(lib_id\s+"([^"]+)"\)/g);
  for (const m of libIds) {
    const full = m[1];
    hints.push(full);
    const short = full.includes(":") ? full.split(":").pop()! : full;
    hints.push(short);
  }
  const values = content.matchAll(
    /\(property\s+"Value"\s+"([^"]+)"/g
  );
  for (const m of values) hints.push(m[1]);
  const refs = content.matchAll(
    /\(property\s+"Reference"\s+"([^"]+)"/g
  );
  for (const m of refs) hints.push(m[1]);
  return [...new Set(hints.map((h) => h.trim()).filter(Boolean))];
}

export function parseBomCsvHints(content: string): string[] {
  const lines = content.split(/\r?\n/).slice(0, 500);
  const hints: string[] = [];
  for (const line of lines) {
    for (const cell of line.split(/[,;\t]/)) {
      const t = cell.trim().replace(/^"|"$/g, "");
      if (t.length >= 2 && t.length < 64 && /[a-zA-Z]/.test(t)) hints.push(t);
    }
  }
  return [...new Set(hints)];
}

export function parseNetlistHints(content: string): string[] {
  const hints: string[] = [];
  // spice-like: R1 1 2 10k, XU1 ...
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("*") || t.startsWith("#")) continue;
    const toks = t.split(/\s+/);
    if (toks[0]) hints.push(toks[0].replace(/[0-9]+$/, "")); // R1 → R
    for (const tok of toks.slice(1, 6)) {
      if (/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(tok)) hints.push(tok);
    }
  }
  return [...new Set(hints)];
}

function agentPrompt(opts: {
  kind: ImportSourceKind;
  sourcePath: string;
  destPath: string;
  textPath?: string;
  hits: CatalogHit[];
  suggestedBoardId?: string;
  userContext?: string;
  twinBuildable?: boolean;
  droppedNotes?: string;
}): string {
  const twinOk = opts.twinBuildable === true;
  return [
    "Customer circuit import for LabWired.",
    `Source kind: ${opts.kind}`,
    `Source file: ${opts.destPath}`,
    opts.textPath ? `Extracted / notes text: ${opts.textPath}` : "",
    opts.suggestedBoardId
      ? `Suggested board/MCU: ${opts.suggestedBoardId}`
      : "No board auto-matched.",
    opts.hits.length
      ? `Catalog hits: ${opts.hits
          .slice(0, 20)
          .map((h) => h.id)
          .join(", ")}`
      : "No catalog hits yet.",
    `twin_buildable: ${twinOk}`,
    "",
    opts.userContext?.trim()
      ? [
          "## User context (authoritative for intent — still no inventing pins)",
          opts.userContext.trim(),
          "",
        ].join("\n")
      : "",
    opts.droppedNotes
      ? ["## Dropped / unmodeled (keep for driver design via datasheet tools)", opts.droppedNotes, ""].join(
          "\n"
        )
      : "",
    "## Design context (ALWAYS use this)",
    "Even if the twin is incomplete or not runnable, use extracts + mapping + user context",
    "plus labwired_part / labwired_datasheet to design drivers, HAL, init, and app structure.",
    "Do not block on twin. Do not invent electrical facts for dropped parts — cite tools or mark missing.",
    "",
    twinOk
      ? [
          "## Twin path (buildable)",
          "1. Prefer catalog parts on the diagram; validate if possible.",
          "2. Scaffold / use existing FW → compile → labwired_run → labwired_verify.",
          "3. model_verified only from verify success.",
        ].join("\n")
      : [
          "## Twin not fully buildable yet",
          "1. Still design firmware/drivers from design context + part/datasheet tools.",
          "2. List what must be modeled for a full twin later (coverage).",
          "3. If a partial board (MCU only) can run, use it for blink/UART beachhead only.",
        ].join("\n"),
    "",
    "Follow skill import-circuit. Prefer MCP labwired_import when available.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function importCircuitSource(opts: {
  sourcePath: string;
  workspaceRoot: string;
  boards: CatalogBoard[];
  partTypes: string[];
  lookup: CatalogLookup;
  forceKind?: ImportSourceKind;
  /** When board suggested, auto-mint blink starter */
  autoMintStarter?: boolean;
  starterPreset?: StarterPreset;
  /** Freeform user notes: board name, goal, constraints, known pins, etc. */
  userContext?: string;
}): MultiImportResult {
  const userContext = (opts.userContext || "").trim();
  const kind = detectKind(opts.sourcePath, opts.forceKind);
  const base = safeBase(opts.sourcePath);
  let destPath = opts.sourcePath;
  let textPath: string | undefined;
  let textBlob = "";
  const extraHints: string[] = [];

  try {
    switch (kind) {
      case "pdf-schematic":
      case "pdf-datasheet": {
        destPath = copyInto(
          opts.workspaceRoot,
          kind === "pdf-datasheet" ? "datasheets" : "import",
          opts.sourcePath
        );
        textPath = path.join(
          opts.workspaceRoot,
          ".labwired",
          "import",
          `${base}.txt`
        );
        const ex = extractPdfText(destPath, textPath);
        if (!ex.ok) {
          return {
            ok: false,
            sourceKind: kind,
            sourcePath: opts.sourcePath,
            destPath,
            hits: [],
            agentPrompt: "",
            summary: `PDF extract failed: ${ex.error}`,
            error: ex.error,
          };
        }
        textBlob = fs.readFileSync(textPath, "utf8");
        if (kind === "pdf-datasheet") {
          // also leave a copy under datasheets for agentic extract
          copyInto(opts.workspaceRoot, "datasheets", opts.sourcePath);
        }
        break;
      }
      case "kicad-sch":
      case "kicad-pcb": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        const raw = fs.readFileSync(destPath, "utf8");
        extraHints.push(...parseKicadSchHints(raw));
        textBlob = raw.slice(0, 500_000);
        textPath = writeText(
          opts.workspaceRoot,
          `${base}.kicad-extract.txt`,
          `# KiCad extract hints\n${extraHints.join("\n")}\n\n--- raw head ---\n${raw.slice(0, 80_000)}`
        );
        break;
      }
      case "netlist": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        textBlob = fs.readFileSync(destPath, "utf8");
        extraHints.push(...parseNetlistHints(textBlob));
        textPath = writeText(
          opts.workspaceRoot,
          `${base}.net-hints.txt`,
          extraHints.join("\n")
        );
        break;
      }
      case "diagram-json": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        // Direct mint
        const mint = mintFromFile(destPath, opts.workspaceRoot, opts.lookup);
        fs.copyFileSync(
          destPath,
          path.join(opts.workspaceRoot, ".labwired", "source-diagram.json")
        );
        if (userContext) {
          writeText(opts.workspaceRoot, "USER_CONTEXT.md", userContext + "\n");
        }
        const prompt = agentPrompt({
          kind,
          sourcePath: opts.sourcePath,
          destPath,
          hits: mint.supported.map((s) => ({
            id: s.resolvedType || s.type,
            kind: "part",
            score: 50,
          })),
          suggestedBoardId: mint.board,
          userContext,
        });
        writeText(opts.workspaceRoot, "AGENT_PROMPT.md", prompt + "\n");
        return {
          ok: mint.ok,
          sourceKind: kind,
          sourcePath: opts.sourcePath,
          destPath,
          hits: [],
          suggestedBoardId: mint.board,
          minted: mint,
          agentPrompt: prompt,
          summary: mint.summary + (userContext ? `\nuser context: set` : ""),
          userContext: userContext || undefined,
        };
      }
      case "image": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        textBlob = `Image schematic: ${path.basename(destPath)}. Use vision/agent to identify board and parts; map only to catalog.`;
        textPath = writeText(
          opts.workspaceRoot,
          `${base}.image-notes.txt`,
          textBlob
        );
        break;
      }
      case "bom-csv": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        textBlob = fs.readFileSync(destPath, "utf8");
        extraHints.push(...parseBomCsvHints(textBlob));
        textPath = writeText(
          opts.workspaceRoot,
          `${base}.bom-hints.txt`,
          extraHints.join("\n")
        );
        break;
      }
      case "text": {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        textBlob = fs.readFileSync(destPath, "utf8");
        textPath = destPath;
        break;
      }
      default: {
        destPath = copyInto(opts.workspaceRoot, "import", opts.sourcePath);
        try {
          textBlob = fs.readFileSync(destPath, "utf8").slice(0, 200_000);
        } catch {
          textBlob = path.basename(destPath);
        }
        textPath = writeText(
          opts.workspaceRoot,
          `${base}.notes.txt`,
          textBlob
        );
      }
    }
  } catch (e) {
    return {
      ok: false,
      sourceKind: kind,
      sourcePath: opts.sourcePath,
      destPath,
      hits: [],
      agentPrompt: "",
      summary: `Import failed: ${e}`,
      error: String(e),
    };
  }

  // User context participates in catalog matching (e.g. "we're on esp32-c3")
  const combined = `${textBlob}\n${extraHints.join("\n")}\n${userContext}`;
  const hits = matchCatalogInText(combined, opts.boards, opts.partTypes);
  // boost explicit KiCad/BOM hints that equal catalog ids
  for (const h of extraHints) {
    const key = h.toLowerCase();
    for (const b of opts.boards) {
      if (
        b.id.toLowerCase() === key ||
        b.chip.toLowerCase() === key ||
        b.mcuType.toLowerCase() === key
      ) {
        hits.unshift({ id: b.id, kind: "board", score: 100 });
      }
    }
    for (const t of opts.partTypes) {
      if (t.toLowerCase() === key) {
        hits.unshift({ id: t, kind: "part", score: 80 });
      }
    }
  }
  // dedupe hits
  const seen = new Set<string>();
  const uniqHits = hits.filter((h) => {
    const k = h.id.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const suggestedBoardId = uniqHits.find(
    (h) => h.kind === "board" || h.kind === "chip"
  )?.id;

  if (userContext) {
    writeText(opts.workspaceRoot, "USER_CONTEXT.md", userContext + "\n");
  }

  const manifest = {
    version: 1,
    sourceKind: kind,
    sourcePath: opts.sourcePath,
    destPath,
    textPath,
    userContext: userContext || null,
    importedAt: new Date().toISOString(),
    hits: uniqHits.slice(0, 30),
    suggestedBoardId: suggestedBoardId || null,
    extraHints: extraHints.slice(0, 100),
  };
  writeText(
    opts.workspaceRoot,
    `${base}.manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n"
  );

  // ——— Real import path: graph → catalog map → diagram → mint ———
  let graph: CircuitGraph | undefined;
  let bomMaps: BomMapResult[] | undefined;

  if (kind === "netlist" && textBlob) {
    graph = parseSpiceNetlist(textBlob);
  } else if (kind === "bom-csv" && textBlob) {
    const rows = parseBomCsv(textBlob);
    bomMaps = mapBomRows(rows, opts.partTypes);
    for (const h of bomMapsToHits(bomMaps)) {
      uniqHits.unshift(h);
    }
    // BOM-only graph: one component per mapped row
    graph = {
      format: "bom",
      components: bomMaps.map((m, i) => ({
        ref: m.row.ref || `U${i + 1}`,
        value: m.catalogType || m.row.value || m.row.raw,
        pins: [],
      })),
      nets: {},
    };
  } else if (
    (kind === "kicad-sch" || kind === "kicad-pcb") &&
    extraHints.length
  ) {
    graph = graphFromHints(extraHints, "kicad-hints");
  } else if (kind === "pdf-schematic" || kind === "text") {
    // hints from catalog hits as weak components
    graph = graphFromHints(
      uniqHits.map((h) => h.id),
      "mixed"
    );
  }

  if (graph && extraHints.length && kind !== "kicad-sch") {
    graph = mergeGraphs(graph, graphFromHints(extraHints));
  }

  let minted: BoardMintResult | undefined;
  const board =
    (suggestedBoardId &&
      (opts.boards.find(
        (b) =>
          b.id === suggestedBoardId ||
          b.chip === suggestedBoardId ||
          b.mcuType === suggestedBoardId
      ) ||
        opts.boards.find(
          (b) =>
            suggestedBoardId!.includes(b.id) ||
            b.id.includes(suggestedBoardId!)
        ))) ||
    opts.boards.find((b) => /esp32c3|c3-supermini/i.test(b.id)) ||
    opts.boards[0];

  if (opts.autoMintStarter !== false && board && graph) {
    try {
      const g2d = graphToDiagram({
        graph,
        board,
        catalogTypes: opts.partTypes,
        bomMaps,
      });
      const lab = path.join(opts.workspaceRoot, ".labwired");
      fs.mkdirSync(lab, { recursive: true });
      fs.writeFileSync(
        path.join(lab, "source-diagram.json"),
        JSON.stringify(g2d.diagram, null, 2) + "\n"
      );
      fs.writeFileSync(
        path.join(lab, "coverage-graph.md"),
        coverageFromMapping(
          g2d.boardId,
          g2d.mapping,
          `${kind}:${path.basename(destPath)}`
        )
      );
      fs.writeFileSync(
        path.join(lab, "graph-mapping.json"),
        JSON.stringify(g2d.mapping, null, 2) + "\n"
      );
      minted = mintFromDiagramObject(
        g2d.diagram,
        opts.workspaceRoot,
        opts.lookup,
        `${kind}:${path.basename(destPath)}`
      );
      // Prefer graph coverage text in summary
      if (g2d.dropped.length) {
        writeText(
          opts.workspaceRoot,
          "DROPPED.md",
          g2d.dropped
            .map((d) => `- ${d.ref}: ${d.value} — ${d.reason}`)
            .join("\n") + "\n"
        );
      }
    } catch {
      /* fall through to starter */
    }
  }

  // Fallback: blink starter if graph path failed but board known
  if (!minted && opts.autoMintStarter !== false && board) {
    const diagram = buildStarterDiagram(board, opts.starterPreset || "blink");
    const lab = path.join(opts.workspaceRoot, ".labwired");
    fs.mkdirSync(lab, { recursive: true });
    fs.writeFileSync(
      path.join(lab, "source-diagram.json"),
      JSON.stringify(diagram, null, 2) + "\n"
    );
    minted = mintFromDiagramObject(
      diagram,
      opts.workspaceRoot,
      opts.lookup,
      `${kind}:starter:${board.id}`
    );
  }

  // Sole flag engine (contextFlags.generated) — do not invent twin_ready from vibes
  const ctxSnap = buildWorkspaceContext(opts.workspaceRoot, userContext);
  const twinBuildable = ctxSnap.twin_buildable;
  const designContextOk = ctxSnap.design_context_ok;

  let droppedNotes = "";
  try {
    const droppedPath = path.join(opts.workspaceRoot, ".labwired", "import", "DROPPED.md");
    if (fs.existsSync(droppedPath)) {
      droppedNotes = fs.readFileSync(droppedPath, "utf8").slice(0, 4000);
    }
  } catch {
    /* */
  }

  const prompt = agentPrompt({
    kind,
    sourcePath: opts.sourcePath,
    destPath,
    textPath,
    hits: uniqHits,
    suggestedBoardId: suggestedBoardId || board?.id,
    userContext,
    twinBuildable,
    droppedNotes: droppedNotes || undefined,
  });
  writeText(opts.workspaceRoot, "AGENT_PROMPT.md", prompt + "\n");

  // Always leave a stable DESIGN_CONTEXT pack for the LLM (even without twin)
  writeText(
    opts.workspaceRoot,
    "DESIGN_CONTEXT.md",
    [
      "# Design context (always — twin optional)",
      "",
      `- twin_buildable: ${twinBuildable}`,
      `- design_context_ok: ${designContextOk}`,
      `- source: ${kind} · ${path.basename(destPath)}`,
      suggestedBoardId || board
        ? `- board_hint: ${suggestedBoardId || board?.id}`
        : "- board_hint: (none)",
      "",
      "## User context",
      userContext || "(none)",
      "",
      "## Catalog hits",
      uniqHits.length
        ? uniqHits.map((h) => `- ${h.id} (${h.kind})`).join("\n")
        : "(none)",
      "",
      "## For the agent",
      "Use this file + USER_CONTEXT.md + extracts to design drivers/FW even if the twin is incomplete.",
      "Cite labwired_part / labwired_datasheet for dropped/unmodeled parts. Never invent pins.",
      twinBuildable
        ? "Twin available: prefer prove path after scaffold."
        : "Twin not fully buildable: design_only first; list catalog gaps for later twin.",
      "",
    ].join("\n")
  );

  const summary = [
    `Imported ${kind}: ${path.basename(destPath)}`,
    textPath ? `text/notes → ${path.relative(opts.workspaceRoot, textPath)}` : "",
    userContext
      ? `user context: ${userContext.slice(0, 120)}${userContext.length > 120 ? "…" : ""}`
      : "user context: (none)",
    graph
      ? `graph: ${graph.components.length} components · ${Object.keys(graph.nets).length} nets`
      : "graph: (none)",
    `design_context: ${designContextOk ? "ok" : "thin"} · twin_buildable: ${twinBuildable}`,
    suggestedBoardId || board
      ? `board: ${suggestedBoardId || board?.id}`
      : "no board auto-matched",
    uniqHits.length
      ? `catalog hits: ${uniqHits
          .slice(0, 10)
          .map((h) => h.id)
          .join(", ")}`
      : "no catalog hits",
    minted
      ? `twin minted: ${minted.board} (${minted.supported.length} parts) [graph pipeline]`
      : "twin not minted — design context still available for drivers/FW",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok: designContextOk || twinBuildable,
    sourceKind: kind,
    sourcePath: opts.sourcePath,
    destPath,
    textPath,
    hits: uniqHits,
    suggestedBoardId: suggestedBoardId || board?.id,
    minted,
    agentPrompt: prompt,
    summary,
    userContext: userContext || undefined,
  };
}

export { detectKind as detectImportKind };
