/**
 * Load .labwired/ pack; flags from sole engine (contextFlags.generated.ts).
 * Do not re-derive mode/twin_buildable here — P0b.
 */
import * as fs from "fs";
import * as path from "path";
import {
  buildLabwiredContext,
  type LabwiredContextPack,
  type LabwiredContextResult,
} from "./contextFlags.generated";

export type WorkspaceContextPack = LabwiredContextPack;

export type WorkspaceContext = LabwiredContextResult & {
  pack: WorkspaceContextPack;
};

function readText(p: string, max = 12000): string | undefined {
  try {
    if (!fs.existsSync(p)) return undefined;
    return fs.readFileSync(p, "utf8").slice(0, max);
  } catch {
    return undefined;
  }
}

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Read workspace .labwired into a context pack (fs only). */
export function loadWorkspacePack(workspaceRoot: string): WorkspaceContextPack {
  const lab = path.join(workspaceRoot, ".labwired");
  const imp = path.join(lab, "import");

  const boardMeta = readJson(path.join(lab, "board.json"));
  const diagram =
    readJson(path.join(lab, "diagram.json")) ||
    readJson(path.join(lab, "source-diagram.json"));
  const coverage = readJson(path.join(lab, "coverage.json"));
  const coverage_md =
    readText(path.join(lab, "coverage.md")) ||
    readText(path.join(imp, "coverage.md"));
  const design_context_md = readText(path.join(imp, "DESIGN_CONTEXT.md"));
  const agent_brief =
    readText(path.join(imp, "AGENT_PROMPT.md")) ||
    readText(path.join(lab, "AGENT_PROMPT.md"));
  const user_context =
    readText(path.join(imp, "USER_CONTEXT.md")) ||
    readText(path.join(lab, "USER_CONTEXT.md"));
  const mappingJson = readJson(path.join(imp, "mapping.json"));
  const mapping = Array.isArray(mappingJson?.mapping)
    ? (mappingJson!.mapping as WorkspaceContextPack["mapping"])
    : Array.isArray(mappingJson)
      ? (mappingJson as WorkspaceContextPack["mapping"])
      : undefined;

  const board =
    (typeof boardMeta?.board === "string" && boardMeta.board) ||
    (diagram && typeof diagram.board === "string" ? diagram.board : undefined) ||
    undefined;
  const mcu =
    (typeof boardMeta?.mcu === "string" && boardMeta.mcu) || undefined;

  const supportedFromCoverage = Array.isArray(coverage?.supported)
    ? (coverage!.supported as unknown[]).length
    : undefined;
  const supportedFromMeta =
    typeof boardMeta?.supportedPartCount === "number"
      ? (boardMeta.supportedPartCount as number)
      : undefined;
  const supported_part_count = supportedFromCoverage ?? supportedFromMeta;

  // Prefer explicit mint flags from board.json when present
  const mint_ok =
    typeof boardMeta?.mint_ok === "boolean"
      ? (boardMeta.mint_ok as boolean)
      : typeof boardMeta?.ok === "boolean"
        ? (boardMeta.ok as boolean)
        : supported_part_count !== undefined
          ? supported_part_count >= 1 && !!board
          : undefined;

  return {
    board,
    mcu,
    diagram,
    user_context,
    agent_brief,
    coverage_md,
    design_context_md,
    mapping,
    ...(typeof mint_ok === "boolean" ? { mint_ok } : {}),
    ...(typeof supported_part_count === "number"
      ? { supported_part_count }
      : {}),
    source_kind:
      design_context_md || mapping
        ? "import"
        : board
          ? "board"
          : undefined,
  };
}

/** Local labwired_context — same pure engine as monorepo. */
export function buildWorkspaceContext(
  workspaceRoot: string | undefined,
  goal?: string
): WorkspaceContext {
  if (!workspaceRoot) {
    const empty = buildLabwiredContext({ goal });
    return { ...empty, pack: {} };
  }
  const pack = loadWorkspacePack(workspaceRoot);
  const result = buildLabwiredContext({ goal, pack });
  return { ...result, pack };
}

/** Compact agent handoff block for Start Agent / freeform. */
export function contextHandoffBlock(ctx: WorkspaceContext): string {
  return [
    "[labwired_context]",
    ctx.summary,
    `next: ${ctx.next.join(" → ")}`,
    "",
    ctx.agent_brief.slice(0, 2500),
    "",
    "Claims: model_verified only via labwired_verify; design_context is not a prove claim.",
  ].join("\n");
}
