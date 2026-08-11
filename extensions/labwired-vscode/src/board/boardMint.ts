/**
 * Diagram → twin mint: keep only catalog-supported parts, write .labwired/.
 * Pure TS (no vscode) so node smoke tests can run it.
 */
import * as fs from "fs";
import * as path from "path";

export type DiagramPart = {
  id: string;
  type: string;
  attrs?: Record<string, string>;
  x?: number;
  y?: number;
  rotate?: number;
};

export type DiagramWire = {
  from: { part: string; pin: string };
  to: { part: string; pin: string };
  color?: string;
};

export type PlaygroundDiagram = {
  version?: number;
  board: string;
  parts: DiagramPart[];
  wires: DiagramWire[];
  firmware?: unknown;
};

export type PartVerdict = {
  id: string;
  type: string;
  status: "supported" | "unknown" | "dropped";
  reason?: string;
  resolvedType?: string;
};

export type BoardMintResult = {
  ok: boolean;
  board: string;
  mcu?: string;
  sourcePath: string;
  outDir: string;
  supported: PartVerdict[];
  dropped: PartVerdict[];
  twin: PlaygroundDiagram;
  coveragePath: string;
  boardPath: string;
  diagramPath: string;
  summary: string;
  errors: string[];
};

export type CatalogLookup = {
  /** Exact or alias-resolved catalog type, or undefined if unknown */
  resolvePartType(type: string): string | undefined;
  /** Normalize board id (aliases), or undefined if unknown */
  resolveBoard(board: string): string | undefined;
  /** True if type is an MCU-class part (optional) */
  isMcuType?(type: string): boolean;
};

/** Common playground / MCP board spellings → catalog board id */
export const BOARD_ALIASES: Record<string, string> = {
  "esp32c3": "esp32-c3-supermini",
  "esp32-c3": "esp32-c3-supermini",
  "esp32c3-supermini": "esp32-c3-supermini",
  "esp32s3": "esp32-s3-zero",
  "esp32-s3": "esp32-s3-zero",
  "stm32l476": "nucleo-l476rg",
  "nucleo-l476rg": "nucleo-l476rg",
  "stm32f401": "nucleo-f401re",
  "nucleo-f401re": "nucleo-f401re",
  "stm32f103": "stm32f103-blinky",
  "stm32f103-blinky": "stm32f103-blinky",
  "rpi-pico": "rpi-pico",
  "rp2040": "rpi-pico",
  "nrf52840": "nrf52840-dk",
  "nrf52840-dk": "nrf52840-dk",
  "esp32": "esp32",
  "adafruit-feather-esp32-v2": "adafruit-feather-esp32-v2",
};

export function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, "-");
}

export function parseDiagram(raw: unknown): PlaygroundDiagram {
  if (!raw || typeof raw !== "object") {
    throw new Error("diagram must be a JSON object");
  }
  const d = raw as Record<string, unknown>;
  const board = String(d.board || "").trim();
  if (!board) throw new Error("diagram.board is required");
  const partsIn = Array.isArray(d.parts) ? d.parts : [];
  const parts: DiagramPart[] = partsIn.map((p, i) => {
    const o = p as Record<string, unknown>;
    const id = String(o.id || `part${i}`);
    const type = String(o.type || "").trim();
    if (!type) throw new Error(`parts[${i}] missing type`);
    return {
      id,
      type,
      attrs: o.attrs as Record<string, string> | undefined,
      x: typeof o.x === "number" ? o.x : undefined,
      y: typeof o.y === "number" ? o.y : undefined,
      rotate: typeof o.rotate === "number" ? o.rotate : undefined,
    };
  });
  const wiresIn = Array.isArray(d.wires) ? d.wires : [];
  const wires: DiagramWire[] = wiresIn.map((w, i) => {
    const o = w as Record<string, unknown>;
    const from = o.from as { part?: string; pin?: string } | undefined;
    const to = o.to as { part?: string; pin?: string } | undefined;
    if (!from?.part || !from?.pin || !to?.part || !to?.pin) {
      throw new Error(`wires[${i}] needs from/to { part, pin }`);
    }
    return {
      from: { part: String(from.part), pin: String(from.pin) },
      to: { part: String(to.part), pin: String(to.pin) },
      color: o.color ? String(o.color) : undefined,
    };
  });
  return {
    version: typeof d.version === "number" ? d.version : 1,
    board,
    parts,
    wires,
    firmware: d.firmware,
  };
}

export function mintTwinFromDiagram(
  diagram: PlaygroundDiagram,
  lookup: CatalogLookup,
  opts: { sourcePath: string; workspaceRoot: string }
): BoardMintResult {
  const errors: string[] = [];
  const outDir = path.join(opts.workspaceRoot, ".labwired");
  const resolvedBoard =
    lookup.resolveBoard(diagram.board) ||
    BOARD_ALIASES[normalizeKey(diagram.board)] ||
    diagram.board;

  if (!lookup.resolveBoard(diagram.board) && !BOARD_ALIASES[normalizeKey(diagram.board)]) {
    // Still allow mint with warning — board string kept as-is for agent
    errors.push(
      `board "${diagram.board}" not in local alias/catalog — kept as-is for agent`
    );
  }

  const supported: PartVerdict[] = [];
  const dropped: PartVerdict[] = [];
  const keptParts: DiagramPart[] = [];
  const keptIds = new Set<string>();
  let mcu: string | undefined;

  for (const part of diagram.parts) {
    const resolved = lookup.resolvePartType(part.type);
    if (!resolved) {
      dropped.push({
        id: part.id,
        type: part.type,
        status: "unknown",
        reason: "type not in LabWired catalog — dropped from twin",
      });
      continue;
    }
    const outPart: DiagramPart = { ...part, type: resolved };
    keptParts.push(outPart);
    keptIds.add(part.id);
    supported.push({
      id: part.id,
      type: part.type,
      status: "supported",
      resolvedType: resolved,
    });
    if (lookup.isMcuType?.(resolved) || /mcu|nucleo|esp32|stm32|nrf|pico|blackpill/i.test(resolved)) {
      mcu = resolved;
    }
  }

  const twinWires = diagram.wires.filter(
    (w) => keptIds.has(w.from.part) && keptIds.has(w.to.part)
  );
  const droppedWires = diagram.wires.length - twinWires.length;

  const twin: PlaygroundDiagram = {
    version: 1,
    board: resolvedBoard,
    parts: keptParts,
    wires: twinWires,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const diagramPath = path.join(outDir, "diagram.json");
  const boardPath = path.join(outDir, "board.json");
  const coveragePath = path.join(outDir, "coverage.json");
  const coverageMdPath = path.join(outDir, "coverage.md");

  const boardMeta = {
    version: 1,
    board: resolvedBoard,
    mcu: mcu || null,
    source: opts.sourcePath,
    mintedAt: new Date().toISOString(),
    supportedPartCount: supported.length,
    /** Alias for labwired_context pack (mint-honest twin_buildable) */
    supported_part_count: supported.length,
    mint_ok: supported.length > 0,
    ok: supported.length > 0,
    droppedPartCount: dropped.length,
    droppedWireCount: droppedWires,
  };

  const coverage = {
    version: 1,
    board: resolvedBoard,
    source: opts.sourcePath,
    supported,
    dropped,
    droppedWireCount: droppedWires,
  };

  fs.writeFileSync(diagramPath, JSON.stringify(twin, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify(boardMeta, null, 2) + "\n", "utf8");
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + "\n", "utf8");

  const md = [
    `# Twin coverage`,
    ``,
    `- **Board:** \`${resolvedBoard}\``,
    `- **MCU:** \`${mcu || "?"}\``,
    `- **Source:** \`${opts.sourcePath}\``,
    `- **Supported parts:** ${supported.length}`,
    `- **Dropped parts:** ${dropped.length}`,
    `- **Dropped wires:** ${droppedWires}`,
    ``,
    `## Supported`,
    ...supported.map(
      (s) =>
        `- \`${s.id}\` · ${s.type}${s.resolvedType && s.resolvedType !== s.type ? ` → ${s.resolvedType}` : ""}`
    ),
    ``,
    `## Dropped (not in catalog — not on twin)`,
    ...(dropped.length
      ? dropped.map((d) => `- \`${d.id}\` · \`${d.type}\` — ${d.reason || "unknown"}`)
      : ["- (none)"]),
    ``,
    `Twin diagram: \`.labwired/diagram.json\``,
    ``,
  ].join("\n");
  fs.writeFileSync(coverageMdPath, md, "utf8");

  const ok = supported.length > 0;
  if (!ok) errors.push("no supported parts — twin is empty");

  const summary = [
    `Board twin minted: ${resolvedBoard}`,
    `supported ${supported.length} · dropped ${dropped.length}` +
      (droppedWires ? ` · wires dropped ${droppedWires}` : ""),
    mcu ? `mcu ${mcu}` : "mcu ?",
    dropped.length
      ? `dropped: ${dropped.map((d) => d.type).join(", ")}`
      : "all parts mapped",
    `→ .labwired/diagram.json · coverage.md`,
    `Next: Start agent and develop against this twin.`,
  ].join("\n");

  return {
    ok,
    board: resolvedBoard,
    mcu,
    sourcePath: opts.sourcePath,
    outDir,
    supported,
    dropped,
    twin,
    coveragePath,
    boardPath,
    diagramPath,
    summary,
    errors,
  };
}

export function loadBoardMeta(
  workspaceRoot: string
): { board: string; mcu?: string } | undefined {
  const p = path.join(workspaceRoot, ".labwired", "board.json");
  try {
    if (!fs.existsSync(p)) return undefined;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      board?: string;
      mcu?: string | null;
    };
    if (!j.board) return undefined;
    return { board: j.board, mcu: j.mcu || undefined };
  } catch {
    return undefined;
  }
}

export function mintFromFile(
  sourcePath: string,
  workspaceRoot: string,
  lookup: CatalogLookup
): BoardMintResult {
  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const diagram = parseDiagram(raw);
  return mintTwinFromDiagram(diagram, lookup, { sourcePath, workspaceRoot });
}

/** Mint from an in-memory starter diagram (catalog New board). */
export function mintFromDiagramObject(
  diagram: PlaygroundDiagram,
  workspaceRoot: string,
  lookup: CatalogLookup,
  sourceLabel = "catalog"
): BoardMintResult {
  return mintTwinFromDiagram(diagram, lookup, {
    sourcePath: sourceLabel,
    workspaceRoot,
  });
}
