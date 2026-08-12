# Product Depth Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver full LabWired Agent product depth (D1–D8): knowledge, multi-source import, twin prove matrix, desk silicon + RTT, composable observability, Marketplace workbench, and enterprise trust packaging — while keeping the twin wedge and dual claims, and refusing Embedder instrument-farm / Open Plot product clones.

**Architecture:** Depth is layered, not a mono-PR. Hosted truth lives in `labwired` monorepo (`packages/api` part-knowledge + MCP handlers, `packages/board-config` importCircuit). Agent kit (`LabWired/agent`) owns skills, ship-gates, desk CLI, and product docs. Workbench is chrome only (`extensions/labwired-vscode`) over the same `labwired agent` engine. Each wave ends with a stranger-visible gate (smoke or ship-gate row), not “code exists.”

**Tech Stack:** LabWired Agent kit (bash/Python), OpenCode pin+wrap, hosted MCP (`api.labwired.com`), `@labwired/board-config`, Cloudflare Worker API (`packages/api`), probe-rs, labwired-sim, Vitest, GitHub Actions, optional VS Code extension packaging.

**Binding specs:**

| Doc | Role |
|-----|------|
| [`docs/PRODUCT_DEPTH.md`](../../PRODUCT_DEPTH.md) | Depth scorecard D1–D8 |
| [`docs/EMBEDDER_PARITY.md`](../../EMBEDDER_PARITY.md) | Job matrix vs Embedder + kill list |
| Monorepo [`docs/strategy/2026-08-05-product-parity-scorecard.md`](../../../../labwired/docs/strategy/2026-08-05-product-parity-scorecard.md) | Path/knowledge/plots scorecard |
| Monorepo [`docs/strategy/2026-08-05-composable-observability-elements.md`](../../../../labwired/docs/strategy/2026-08-05-composable-observability-elements.md) | Plots = elements rule |

**Kill list (do not schedule):**

- 30+ instrument product surface / Open Plot ready-made product  
- Claiming `hardware_observed` as twin green  
- Forking OpenCode (pin+wrap only)

**Already shipped (do not re-litigate):**

- Install → login → doctor live-probe (0.3.11)  
- Twin live-gate1 → `model_verified`  
- Dual claims + domain packs  
- Multi-source import code path (bom/text/kicad/netlist design context) in monorepo PR train — **finish deploy + E2E** in Wave B  
- `labwired probe rtt` status helper  

---

## Wave map (execute in order)

| Wave | Depth IDs | Outcome | Exit gate |
|------|-----------|---------|-----------|
| **A** | D1 | Knowledge coverage + skill enforcement | ship-gate knowledge rows green on heroes + coverage floor |
| **B** | D2 | Multi-source import production | Deployed MCP + fixture E2E for bom/kicad/pdf_text + twin when possible |
| **C** | D3+D4 | Twin matrix + desk silicon E2E | Multi-board twin prove; optional real-probe job; RTT capture path |
| **D** | D5+D6 | Observability job + workbench G2 | “Show me X” compose E2E; SHIP_CHECKLIST G2 green |
| **E** | D7 | Enterprise trust pack | Security/self-host docs + air-gap install path documented & tested |
| **—** | D8 | Wedge guardrails | Continuous: dual claims + no instrument-farm PRs |

Each wave is independently shippable. Do not start Wave D until A–C exit gates pass.

---

## File ownership map

| Area | Primary paths |
|------|----------------|
| Knowledge store | `labwired/packages/api/src/part-knowledge/*`, seed/catalog |
| Knowledge agent gate | `labwired-agent/scripts/knowledge-top-parts.py`, `knowledge-mcp-smoke.sh`, `ship-gate.sh`, `skills/bringup/SKILL.md` |
| Import pure | `labwired/packages/board-config/src/import-circuit.ts` |
| Import hosted | `labwired/packages/api/src/mcp/handlers/import.ts`, `mcp-tools.ts` |
| Import agent | `labwired-agent/skills/import-circuit/SKILL.md`, `scripts/import-diagram-smoke.sh` (+ expand) |
| Twin prove | `labwired-agent/scripts/live-gate1.sh`, `fixtures/gate1-live/*`, `skills/prove/SKILL.md` |
| Desk / RTT | `labwired-agent/lib/probe.sh`, `lib/serial-capture.sh`, `skills/desk-hw/SKILL.md`, `scripts/desk-hw-smoke.sh` |
| Observability | `labwired-agent/skills/observe/SKILL.md`, `scripts/compose-elements.py`, workbench plot providers |
| Workbench | `labwired-agent/extensions/labwired-vscode/*`, `SHIP_CHECKLIST.md` |
| Enterprise | `labwired-agent/docs/` + monorepo security/self-host docs; install airgap profile |
| Claims | `labwired-agent/config/AGENTS.md`, `docs/VERIFY.md`, `lib/assert-status.sh` |

---

## Wave A — Knowledge depth (D1)

### Task A1: Define Top-N hero contract and fail floor

**Files:**

- Create: `labwired-agent/share/catalog/knowledge-heroes.required.json` (or extend `kit-heroes.json` with `required: true`)
- Modify: `labwired-agent/scripts/knowledge-mcp-smoke.sh`
- Modify: `labwired-agent/scripts/ship-gate.sh`
- Test: extend smoke to fail if any required hero lacks `part` **or** `datasheet` hit when session present

- [ ] **Step 1: Freeze required hero list (min 8)**

Use existing kit heroes; mark them required. Example shape:

```json
{
  "required": [
    { "id": "adxl345", "kind": "part" },
    { "id": "bme280", "kind": "part" },
    { "id": "ssd1306", "kind": "part" },
    { "id": "esp32-c3-supermini", "kind": "board" },
    { "id": "nucleo-l476rg", "kind": "board" },
    { "id": "nrf52840", "kind": "mcu" },
    { "id": "rp2040", "kind": "mcu" },
    { "id": "stm32l476", "kind": "mcu" }
  ]
}
```

- [ ] **Step 2: Tighten knowledge-mcp-smoke**

For each required hero:

```bash
# tools/call labwired_part { query: id } OR labwired_list + labwired_datasheet { part: id }
# PASS only if structured outcome OK or non-empty hits
```

Floor: **100% of required heroes** have at least one of: `part` OK, `datasheet` OK, or `list` hit with subsequent part resolve.

- [ ] **Step 3: Wire ship-gate**

`ship-gate` already calls knowledge-mcp-smoke when session exists. Ensure session-less CI still runs local coverage; with session, required floor is hard fail.

- [ ] **Step 4: Commit agent**

```bash
git commit -m "test(knowledge): required hero floor in knowledge-mcp-smoke"
```

### Task A2: Seed / fix knowledge store for missing heroes

**Files:**

- Modify: `labwired/packages/api/src/part-knowledge/catalog-seed.ts` (and seed data paths used by production)
- Modify: datasheet fixtures / R2 keys as existing pipeline requires
- Test: API unit tests under `packages/api/tests/` for part + datasheet OK on required IDs (mock D1/R2 as existing tests do)

- [ ] **Step 1: Run knowledge-mcp-smoke; list FAIL ids**

```bash
cd labwired-agent && bash scripts/knowledge-mcp-smoke.sh
```

- [ ] **Step 2: For each FAIL, add/fix part fact and datasheet blob via existing seed pipeline**

Do not invent pinouts — only curated or extracted datasheet text already licensed for use.

- [ ] **Step 3: Deploy API / wait for production seed path** (follow monorepo deploy convention)

- [ ] **Step 4: Re-run smoke until 100% required heroes pass**

### Task A3: Skill enforcement — facts before code

**Files:**

- Modify: `labwired-agent/skills/bringup/SKILL.md`
- Modify: `labwired-agent/config/AGENTS.md` (session orientation — already has list/part/datasheet; tighten)

- [ ] **Step 1: Add hard sequence to bringup**

```text
1. labwired_list / describe
2. labwired_part (prefer facts)
3. labwired_datasheet if fact missing
4. If both miss → stop and ask user; never invent pins/registers
```

- [ ] **Step 2: Add AGENTS.md bullet**

Reject any firmware that hardcodes addresses not returned by tools in this session.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(skills): enforce part/datasheet before inventing pins"
```

**Wave A exit:** `knowledge-mcp-smoke` PASS on production session for all required heroes; skills enforce order.

---

## Wave B — Import depth (D2)

### Task B1: Land multi-source import on production MCP

**Files (monorepo):**

- `packages/board-config/src/import-circuit.ts` (already extended — verify on main)
- `packages/api/src/mcp/handlers/import.ts`
- `packages/board-config/src/mcp-tools.ts`
- `packages/mcp/src/handlers/context-import.ts`
- Tests: `packages/board-config/test/import-circuit.test.ts`

- [ ] **Step 1: Merge/deploy PR** `feat/import-multi-source` (or equivalent) to production API

- [ ] **Step 2: Live MCP check**

```bash
# tools/call labwired_import source_kind=bom_csv with board_hint + content
# tools/call labwired_import source_kind=kicad_sch sample
# tools/call labwired_import source_kind=pdf_text sample
# Expect design_context_ok true; twin_buildable when catalog allows
```

- [ ] **Step 3: Fail closed if production still returns only diagram_json**

### Task B2: Expand agent import smoke to all source kinds

**Files:**

- Modify: `labwired-agent/scripts/import-diagram-smoke.sh` → rename or add `import-multi-smoke.sh`
- Modify: `labwired-agent/scripts/ship-gate.sh`
- Create fixtures: `labwired-agent/fixtures/import/sample.bom.csv`, `sample.kicad_sch`, `sample.pdf.txt`

- [ ] **Step 1: Local pure path**

Call `importCircuit` via a small node script against board-config **or** live MCP:

```bash
# For each fixture: assert design_context_ok
# For diagram_json fixture: assert twin_buildable
```

- [ ] **Step 2: Fixture contents (minimal)**

`sample.bom.csv`:

```csv
Ref,MPN,Qty
U1,ADXL345,1
U2,BME280,1
```

`sample.pdf.txt`: prose mentioning ESP32-C3 + ADXL345.

`sample.kicad_sch`: minimal s-expr with `lib_id` + Value.

- [ ] **Step 3: ship-gate calls multi-smoke**

- [ ] **Step 4: Commit**

```bash
git commit -m "test(import): multi-source import smoke fixtures"
```

### Task B3: Import quality loop (catalog mapping)

**Files:**

- Catalog parts: monorepo catalog / board-config catalog
- Mapping improvements in `import-circuit.ts` (aliases, common module names)

- [ ] **Step 1: Collect dropped parts from real imports**

- [ ] **Step 2: Add catalog aliases or part types for top dropped names**

- [ ] **Step 3: Raise twin_buildable rate on internal sample set (target: ≥3 real boards documented)**

**Wave B exit:** Production MCP multi-source import works; agent smokes all source_kinds; at least one KiCad or BOM path mints twin for a hero board.

---

## Wave C — Twin matrix + desk silicon (D3 + D4)

### Task C1: Expand twin prove board matrix

**Files:**

- `labwired-agent/scripts/live-gate1.sh` (parameterize chip)
- Fixtures under `fixtures/gate1-live/` or per-board dirs
- Catalog systems under `share/catalog/systems/`

- [ ] **Step 1: List boards with sim systems + demo firmware**

Minimum targets: `esp32c3` (existing), `stm32l476` or nucleo, `rp2040` or `nrf52840` if sim-ready.

- [ ] **Step 2: For each board, red→green script or matrix job**

```bash
LABWIRED_GATE1_CHIP=esp32c3 ./scripts/live-gate1.sh
LABWIRED_GATE1_CHIP=<next> ./scripts/live-gate1.sh
```

- [ ] **Step 3: CI matrix (optional nightly) for multi-chip**

- [ ] **Step 4: Commit**

```bash
git commit -m "test(twin): multi-board live-gate matrix"
```

### Task C2: Physical desk E2E (optional CI, required manual gate)

**Files:**

- Modify: `labwired-agent/scripts/desk-hw-smoke.sh`
- Create: `labwired-agent/scripts/desk-hw-physical.sh` (skip if no probe)
- Skill: `skills/desk-hw/SKILL.md` (already has rules)

- [ ] **Step 1: Physical script**

```bash
# if probe-rs list empty → skip 0 with message
# else: flash known ELF --chip from env
# serial-capture for LABWIRED_OK
# assert hardware_observed
# assert-status must NOT accept that JSON as model_verified
```

- [ ] **Step 2: Document operator env**

```bash
export LABWIRED_HW_CHIP=...
export LABWIRED_HW_PORT=...
export LABWIRED_HW_MARKER=LABWIRED_OK
```

- [ ] **Step 3: Dual-claim unit check**

```bash
labwired-agent assert-status model_verified <hw-result.json>  # must FAIL
labwired-agent assert-status hardware_observed <hw-result.json>  # must PASS
```

### Task C3: RTT capture path

**Files:**

- Modify: `labwired-agent/lib/probe.sh` (`labwired_probe_rtt` → real attach/read when probe-rs allows)
- Modify: `labwired-agent/lib/serial-capture.sh` or add `lib/rtt-capture.sh`
- Modify: `skills/desk-hw/SKILL.md`

- [ ] **Step 1: Spike probe-rs RTT CLI on one Nordic/STM board**

Document exact args that work on LabWired desk hardware.

- [ ] **Step 2: Implement `labwired probe rtt-capture <marker> <timeout>`**

Output JSON same shape as serial-capture (`status: hardware_observed|failed`, excerpt, marker).

- [ ] **Step 3: desk-hw-smoke optional RTT section when probe present**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desk): RTT capture path for hardware_observed"
```

**Wave C exit:** ≥2 twin chips green in automation; physical desk script works when probe attached; RTT path either works or fails with explicit “use UART” (no silent invent).

---

## Wave D — Observability + workbench (D5 + D6)

### Task D1: “Show me a plot of X” job E2E

**Files:**

- `labwired-agent/skills/observe/SKILL.md`
- `labwired-agent/scripts/compose-elements.py`
- Fixtures: UART / capture under `fixtures/observability/`
- Workbench: only if adopting existing Plot provider (no new Open Plot product)

- [ ] **Step 1: Define element catalog table in observe skill** (serial series, GPIO edges, markers)

- [ ] **Step 2: Automated compose from live-gate1 UART** (already partial in ship-gate)

- [ ] **Step 3: Agent-facing recipe**

```text
User: plot LED vs UART markers
→ observe skill → labwired compose / compose-elements.py → JSON series
```

- [ ] **Step 4: Optional workbench: load composed JSON into existing plot panel only**

### Task D2: Workbench Marketplace G2

**Files:**

- `labwired-agent/extensions/labwired-vscode/SHIP_CHECKLIST.md`
- Extension `package.json`, compile, VSIX scripts

- [ ] **Step 1: Walk SHIP_CHECKLIST G0→G2** — tick only with evidence

- [ ] **Step 2: Fix CLI argv contract + login env (already partially done)**

- [ ] **Step 3: Remove / honest-stub billing/team**

- [ ] **Step 4: Package VSIX + sideload golden path**

```text
Install CLI → Log in → Doctor → Start Agent → twin prove prompt
```

- [ ] **Step 5: Marketplace listing only after G2 green**

**Wave D exit:** compose E2E documented + automated; workbench G2 checklist fully green with recorded path.

---

## Wave E — Enterprise trust (D7)

### Task E1: Security & privacy pack (docs + process, not fake certs)

**Files:**

- Create: `labwired-agent/docs/SECURITY.md`
- Create: `labwired-agent/docs/SELF_HOST.md` (or monorepo ops docs)
- Link from README
- Align with live `labwired.com/privacy` + `terms`

- [ ] **Step 1: SECURITY.md** — threat model (token theft, prompt exfil, desk flash risk), contact security@labwired.com, disclosure

- [ ] **Step 2: SELF_HOST.md** — airgap profile, `LABWIRED_MCP_ENTRY`, local model URL, what still needs cloud

- [ ] **Step 3: DPA request path** — document “email privacy@labwired.com for DPA” (legal process)

- [ ] **Step 4: SOC2/ISO** — track as company process milestone; product code only prepares evidence (logs, access, retention)

### Task E2: Air-gap install automated test

**Files:**

- `labwired-agent/tests/` or CI job with `LABWIRED_PROFILE=airgap`
- Require vendored MCP entry fixture

- [ ] **Step 1: CI job fails closed without MCP entry**

- [ ] **Step 2: CI job passes with fake vendor `mcp/vendor/index.js` stub that exits 0 on --help**

**Wave E exit:** Security + self-host docs linked from README; airgap install test green; SOC2 marked as org track with owner.

---

## Continuous — Wedge guardrails (D8)

### Task G1: Dual-claim regression always on

**Files:**

- `tests/hosted-auth-probe.sh` (assert-status fixed/broken)
- `scripts/desk-hw-smoke.sh`
- `config/AGENTS.md`

- [ ] **Step 1: Never remove assert-status reject of broken fixture**

- [ ] **Step 2: Any new HW JSON path must fail `assert-status model_verified`**

### Task G2: PR checklist

- [ ] **Step 1: Add CONTRIBUTING or PR template bullet**

```text
- [ ] Does not add instrument-farm / Open Plot product
- [ ] Does not rename desk success to twin green
- [ ] ship-gate / relevant smokes green
```

---

## Cross-cutting release train

### Task R1: Version cadence

- Patch (0.3.x): gates, doctor, docs  
- Minor (0.4.0): Wave A+B exit  
- Minor (0.5.0): Wave C exit  
- Minor (0.6.0): Wave D exit  
- Docs/process: Wave E can ship anytime after A  

### Task R2: Every wave ends with

```bash
cd labwired-agent
./scripts/ship-gate.sh
# plus wave-specific smokes
curl -fsSL https://labwired.com/install | bash   # version check after tag
```

### Task R3: Production dependencies

| Dependency | Owner |
|------------|--------|
| API deploy for import + knowledge seed | monorepo `packages/api` |
| Part/datasheet seed data | part-knowledge pipeline |
| Agent kit tag | `LabWired/agent` releases |
| Landing marketing if needed | `labwired-landing` |

---

## Suggested execution order (first 2 weeks)

| Day | Focus |
|-----|--------|
| 1–2 | A1+A3 (hero floor + skill enforcement) |
| 3–5 | A2 (seed FAIL heroes) until smoke 100% |
| 6–7 | B1 deploy multi-source import + B2 agent multi-smoke |
| 8–10 | B3 catalog aliases from dropped list |
| 11–14 | C1 second twin chip + C2 physical script when hardware available |

---

## Verification plan (program level)

1. **Always:** `labwired-agent` `./scripts/ship-gate.sh` → `ship-gate PASS`  
2. **Wave A:** required heroes knowledge-mcp 100%; bringup skill forbids invent  
3. **Wave B:** live MCP multi-source import; multi-smoke fixtures green  
4. **Wave C:** multi-chip live-gate; physical optional; RTT capture or explicit fallback  
5. **Wave D:** compose E2E; SHIP_CHECKLIST G2 complete  
6. **Wave E:** SECURITY + SELF_HOST linked; airgap CI green  
7. **Never:** instrument farm or dual-claim regression  

---

## Self-review (plan quality)

| Spec item (PRODUCT_DEPTH) | Task coverage |
|---------------------------|---------------|
| D1 Knowledge | Wave A A1–A3 |
| D2 Import | Wave B B1–B3 |
| D3 Twin prove | Wave C C1 (+ existing live-gate1) |
| D4 Desk + RTT | Wave C C2–C3 |
| D5 Observability | Wave D D1 |
| D6 Workbench | Wave D D2 |
| D7 Enterprise | Wave E E1–E2 |
| D8 Wedge | Continuous G1–G2 |
| Kill list | Explicit; no tasks add instruments/Open Plot |

No TBD steps: each task names files, commands, and exit criteria.

---

## Execution handoff

**Plan complete and saved to**  
`labwired-agent/docs/superpowers/plans/2026-08-12-product-depth-program.md`

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task (start Wave A Task A1), review between tasks  
2. **Inline Execution** — this session runs Wave A then B with checkpoints  

**Which approach?**
