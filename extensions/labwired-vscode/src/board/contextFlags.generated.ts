/** GENERATED — do not hand-edit. Run scripts/sync-context-core.sh */
/* source: packages/board-config/src/labwired-context.ts */
/**
 * labwired_context — sole flag/mode engine (design always · twin when mint-honest).
 * @see docs/superpowers/plans/2026-08-11-context-first-p0.md
 */

export type ContextMappingRow = {
  ref: string;
  value: string;
  status: string;
  reason?: string;
  catalog_type?: string;
};

export type ContextCatalogHit = {
  id: string;
  kind?: string;
  score?: number;
};

export type LabwiredContextPack = {
  board?: string;
  mcu?: string;
  diagram?: Record<string, unknown> | object;
  user_context?: string;
  agent_brief?: string;
  coverage_md?: string;
  design_context_md?: string;
  mapping?: ContextMappingRow[];
  catalog_hits?: ContextCatalogHit[];
  /** Explicit override; prefer mint_ok path for honesty */
  twin_buildable?: boolean;
  design_context_ok?: boolean;
  firmware_hints?: string;
  source_kind?: string;
  /** Catalog mint succeeded with ≥1 supported part */
  mint_ok?: boolean;
  supported_part_count?: number;
};

export type LabwiredContextInput = {
  goal?: string;
  project_id?: string;
  pack?: LabwiredContextPack;
};

export type LabwiredContextMode = 'empty' | 'design_only' | 'twin_ready';
export type LabwiredContextQuality = 'none' | 'thin' | 'ok';

export type LabwiredContextResult = {
  ok: boolean;
  mode: LabwiredContextMode;
  quality: LabwiredContextQuality;
  design_context_ok: boolean;
  twin_buildable: boolean;
  board?: string;
  mcu?: string;
  summary: string;
  agent_brief: string;
  next: string[];
  mapping?: ContextMappingRow[];
  dropped?: ContextMappingRow[];
  diagram?: Record<string, unknown>;
  claims: {
    model_verified: string;
    hardware_observed: string;
    design_context: string;
  };
  sources: string[];
  error?: string;
};

const CLAIMS = {
  model_verified: 'only via labwired_verify (never from chat confidence)',
  hardware_observed: 'only via desk-hw / real probe — never rename to model_verified',
  design_context: 'usable for drivers/FW design; not a prove claim',
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

function meetsMvc(pack: LabwiredContextPack, board: string | undefined): boolean {
  if (typeof pack.design_context_ok === 'boolean') return pack.design_context_ok;
  if (board) return true;
  if (pack.mint_ok === true) return true;
  const mapping = pack.mapping ?? [];
  if (mapping.some((r) => (r.status || '').toLowerCase() === 'mapped')) return true;
  const brief = nonEmptyString(pack.agent_brief);
  const user = nonEmptyString(pack.user_context);
  if (brief && brief.length >= 80 && (user && user.length >= 20 || mapping.length >= 1)) {
    return true;
  }
  return false;
}

function hasAnyText(pack: LabwiredContextPack): boolean {
  return !!(
    nonEmptyString(pack.user_context) ||
    nonEmptyString(pack.agent_brief) ||
    nonEmptyString(pack.coverage_md) ||
    nonEmptyString(pack.design_context_md) ||
    nonEmptyString(pack.firmware_hints) ||
    (pack.mapping && pack.mapping.length) ||
    (pack.catalog_hits && pack.catalog_hits.length) ||
    pack.diagram
  );
}

function computeTwinBuildable(pack: LabwiredContextPack): boolean {
  if (typeof pack.twin_buildable === 'boolean') return pack.twin_buildable;
  const supported = pack.supported_part_count ?? 0;
  return pack.mint_ok === true && supported >= 1;
}

/**
 * Build labwired_context from an optional pack (+ goal).
 * Deterministic; no I/O.
 */
export function buildLabwiredContext(input: LabwiredContextInput = {}): LabwiredContextResult {
  const pack = input.pack ?? {};
  const sources: string[] = [];
  if (input.project_id) sources.push(`project_id:${input.project_id}`);
  if (input.goal) sources.push('goal');

  const boardFromPack = nonEmptyString(pack.board);
  const diagram = asRecord(pack.diagram);
  const boardFromDiagram =
    diagram && typeof diagram.board === 'string' ? nonEmptyString(diagram.board) : undefined;
  const board = boardFromPack || boardFromDiagram;
  if (boardFromPack) sources.push('pack.board');
  if (boardFromDiagram) sources.push('pack.diagram.board');
  if (pack.mcu) sources.push('pack.mcu');
  if (pack.user_context) sources.push('pack.user_context');
  if (pack.agent_brief) sources.push('pack.agent_brief');
  if (pack.coverage_md) sources.push('pack.coverage_md');
  if (pack.design_context_md) sources.push('pack.design_context_md');
  if (pack.mapping?.length) sources.push('pack.mapping');
  if (pack.catalog_hits?.length) sources.push('pack.catalog_hits');
  if (pack.firmware_hints) sources.push('pack.firmware_hints');
  if (pack.source_kind) sources.push(`pack.source_kind:${pack.source_kind}`);
  if (diagram) sources.push('pack.diagram');
  if (typeof pack.mint_ok === 'boolean') sources.push(`pack.mint_ok:${pack.mint_ok}`);
  if (typeof pack.supported_part_count === 'number') {
    sources.push(`pack.supported_part_count:${pack.supported_part_count}`);
  }

  const mapping = Array.isArray(pack.mapping) ? pack.mapping : undefined;
  const dropped = mapping?.filter((row) => {
    const status = (row.status || '').toLowerCase();
    return status === 'dropped' || status === 'unknown';
  });

  const design_context_ok = meetsMvc(pack, board);
  const twin_buildable = computeTwinBuildable(pack);

  let quality: LabwiredContextQuality = 'none';
  if (design_context_ok) quality = 'ok';
  else if (hasAnyText(pack) || board) quality = 'thin';

  let mode: LabwiredContextMode = 'empty';
  if (twin_buildable) mode = 'twin_ready';
  else if (design_context_ok) mode = 'design_only';

  const next: string[] = [];
  if (mode === 'empty') {
    next.push('labwired_import', 'labwired_list', 'new_board');
  } else if (mode === 'design_only') {
    next.push('labwired_part', 'labwired_datasheet', 'agent_draft');
    if (dropped?.length) next.push('catalog_gap_report');
    next.push('labwired_import');
  } else {
    next.push('labwired_validate', 'labwired_compile', 'labwired_run', 'labwired_verify');
  }

  const mappedCount = mapping?.filter((r) => (r.status || '').toLowerCase() === 'mapped').length;
  const droppedCount = dropped?.length ?? 0;

  const summaryParts = [
    `mode=${mode}`,
    `quality=${quality}`,
    `design_context_ok=${design_context_ok}`,
    `twin_buildable=${twin_buildable}`,
    board ? `board=${board}` : 'board=—',
    pack.mcu ? `mcu=${pack.mcu}` : null,
    mapping ? `mapping=${mappedCount ?? 0} mapped / ${droppedCount} dropped` : null,
    input.goal ? `goal=${input.goal.slice(0, 80)}` : null,
  ].filter(Boolean) as string[];

  let agent_brief = nonEmptyString(pack.agent_brief) || '';
  if (!agent_brief) {
    if (mode === 'empty') {
      agent_brief =
        quality === 'thin'
          ? 'Context is thin. Import a diagram_json (or richer notes + mapped parts) before drafting drivers.'
          : 'No design context yet. Import diagram_json or open a catalog board, then call labwired_context again.';
    } else if (mode === 'design_only') {
      agent_brief =
        'Design context is available; twin is not mint-ready. Design drivers/FW from mapping + user_context + labwired_part/datasheet. Never invent pins for dropped parts. Do not claim model_verified.';
    } else {
      agent_brief =
        'Twin is mint-ready. Validate diagram, compile, labwired_run, then labwired_verify for model_verified.';
    }
    if (nonEmptyString(pack.user_context)) {
      agent_brief += `\n\nUser context:\n${pack.user_context!.trim()}`;
    }
    if (input.goal) {
      agent_brief += `\n\nGoal: ${input.goal.trim()}`;
    }
  }

  return {
    ok: mode !== 'empty',
    mode,
    quality,
    design_context_ok,
    twin_buildable,
    ...(board ? { board } : {}),
    ...(pack.mcu ? { mcu: pack.mcu } : {}),
    summary: summaryParts.join(' · '),
    agent_brief,
    next,
    ...(mapping ? { mapping } : {}),
    ...(dropped && dropped.length ? { dropped } : {}),
    ...(twin_buildable && diagram ? { diagram } : {}),
    claims: { ...CLAIMS },
    sources: sources.length ? sources : ['(empty pack)'],
    ...(mode === 'empty' ? { error: 'empty_context' } : {}),
  };
}
