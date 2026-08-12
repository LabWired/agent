---
name: import-circuit
description: >-
  Ingest customer circuit sources (PDF schematic, KiCad, netlist, BOM, image,
  diagram.json) into a catalog-honest LabWired twin diagram. Never invent pins.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "bringup"
---

# Import circuit → twin (catalog-honest)

Use when the user brings **any** entry into LabWired: schematic/PDF/KiCad/netlist/BOM/image,
**or existing firmware/repo**, or “make this board debuggable on the twin.”

## Product fact (not format worship)

**Two outcomes — twin is optional for design work:**

```text
entry (schematic | code | notes | catalog board)
  │
  ├─► ALWAYS: design context for the LLM
  │     extracts, BOM/mapping, dropped parts, user_context, datasheets
  │     → design drivers, HAL, init, app structure, tests-as-spec
  │
  └─► WHEN BUILDABLE: debuggable twin
        → FW loop: compile → labwired_run → labwired_verify → prove
```

If the twin **cannot** be built (unmodeled parts, incomplete nets, no board id):

- **Do not stop.** Use import context + `labwired_part` / `labwired_datasheet` to design firmware anyway.  
- Be explicit: “twin partial / not runnable yet; designing against catalog + datasheet facts.”  
- Never claim `model_verified` without prove; never invent pins for dropped parts.

## Preferred path (server tool)

**1. Orient with `labwired_context`** (always — even before import if `.labwired/` exists).  
**2. Ingest with `labwired_import`** when available.  
**3. Re-call `labwired_context`** with the import pack (or workspace pack).

```text
labwired_context({ pack? | project_id? })     ← design_context_ok + twin_buildable + next[]
labwired_import({ source_kind, content, user_context, board_hint? })
  → design context always (mapping, coverage, agent_brief)
  → diagram only if twin_buildable
labwired_context({ pack from import })        ← handoff

if twin_buildable / mode=twin_ready:
  labwired_validate → compile → run → verify
else:
  design_only: drivers/FW from context + part/datasheet tools
  list what catalog needs to model for full twin later
```

For **existing code**: `firmware_tree` / `project_hints` + user_context; still produce design context even if sim board is missing.

Design: monorepo `docs/superpowers/specs/2026-08-11-labwired-import-server-tool-design.md`

## Hard rules

1. **Never invent** pinouts, I²C addresses, or part behavior.  
2. Twin parts **must** be catalog-mapped; design may reference dropped parts only via **cited** datasheet/part tools.  
3. Unknown twin parts → **dropped** with reasons — keep them in coverage for the LLM.  
4. Twin green only via **`prove`** / `labwired_verify`.  
5. Prefer `.labwired/import/` + `USER_CONTEXT.md` as inputs to `labwired_import`.

## Inputs (any of these)

| Source | `source_kind` |
|--------|----------------|
| PDF extract text | `pdf_text` |
| KiCad sch body | `kicad_sch` |
| Netlist | `netlist` |
| BOM CSV | `bom_csv` |
| diagram.json | `diagram_json` |
| Notes | `text` |
| Image (later) | `image_ref` |

## Handoff

| Next | Pack / tool |
|------|-------------|
| ERC | `labwired_validate` |
| Twin prove | `prove` / `labwired_verify` |
| Full loop | `golden-path` |


## Local kit proof (always available)

For `diagram_json` fixtures, the kit ships a catalog-honest smoke:

```bash
./scripts/import-diagram-smoke.sh fixtures/gate1/diagram.json
```

Requires: `board` known in `share/catalog/systems` and parts mappable without inventing pins.
Hosted `labwired_import` / `labwired_resolve_circuit` extend this when signed in.
