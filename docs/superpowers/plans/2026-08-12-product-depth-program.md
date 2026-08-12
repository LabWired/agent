# Product Depth — Task Plan

> **For agentic workers:** Execute tasks in order. Each task ends with a **hard gate** (command + expected output). No skip. No “partial.” If blocked, stop and name the blocker.

**Goal:** Close product depth so strangers get knowledge, import, twin prove, desk silicon (UART + RTT), compose plots, workbench usable, dual claims held — without instrument-farm / Open Plot clones.

**Repos:**

| Area | Primary paths |
|------|----------------|
| Agent kit | `LabWired/agent` — skills, scripts, ship-gate, desk CLI |
| Import pure | `labwired/packages/board-config/src/import-circuit.ts` |
| Import hosted | `labwired/packages/api/src/mcp/handlers/import.ts` |
| Knowledge | `labwired/packages/api/src/part-knowledge/*` |
| Workbench | `labwired-agent/extensions/labwired-vscode/*` |

**Kill (do not implement):** 30+ instruments, Open Plot product, desk green renamed to twin green.

**Already done (do not redo):** install/login/doctor live-probe 0.3.11, live-gate1 esp32c3, dual-claim assert-status, multi-source import code (land/deploy if not on prod).

---

## Task 1 — Required knowledge heroes file

**Status: done** (ledger)

**Files:** Create `share/catalog/knowledge-required.json`

- [x] Write file with exactly these required ids (edit only if a hero is retired and replaced 1:1):

```json
{
  "version": 1,
  "required": [
    { "id": "adxl345", "need": ["part"] },
    { "id": "bme280", "need": ["part", "list"] },
    { "id": "ssd1306", "need": ["list"] },
    { "id": "esp32-c3-supermini", "need": ["list"] },
    { "id": "nucleo-l476rg", "need": ["list"] },
    { "id": "nrf52840", "need": ["list"] },
    { "id": "rp2040", "need": ["list"] },
    { "id": "stm32l476", "need": ["list"] }
  ]
}
```

- [ ] Commit: `chore(knowledge): freeze required hero list`

**Gate:** `test -f share/catalog/knowledge-required.json && python3 -c "import json; d=json.load(open('share/catalog/knowledge-required.json')); assert len(d['required'])==8"`

---

## Task 2 — Knowledge smoke enforces 100% required

**Status: done** (ledger)

**Files:** Modify `scripts/knowledge-mcp-smoke.sh`

- [x] Load `share/catalog/knowledge-required.json`
- [x] For each required id, call hosted MCP (Accept: `application/json` only):
  - if `need` contains `part` → `labwired_part` query=id → outcome must be `OK` (not `NOT_FOUND`)
  - if `need` contains `list` → `labwired_list` with filter=id → non-empty boards/components/items
  - if `need` contains `datasheet` → `labwired_datasheet` part=id → outcome `OK`
- [x] Exit 1 if any required fails
- [x] Keep ADXL345 part+datasheet POWER_CTL as extra canary (existing)

- [x] Commit: `test(knowledge): required heroes hard fail in knowledge-mcp-smoke`

**Gate (signed-in session):**

```bash
bash scripts/knowledge-mcp-smoke.sh
```

Expected: every required id `ok`, script exit 0. No session → exit 2 with `need cloud.json`.

---

## Task 3 — Seed / fix store until Task 2 is green

**Status: done** (prod D1 0034 applied; PR #1613)

**Files:** monorepo `packages/api/src/part-knowledge/*` (seed/catalog as used in prod)

- [x] Run Task 2; collect FAIL ids
- [x] For each FAIL: add curated part fact and/or datasheet so tool returns OK (no invented pins)
- [x] Deploy API / seed per monorepo process
- [x] Re-run Task 2 until green

**Gate:** Task 2 exit 0 on production API with a real session.

---

## Task 4 — bringup skill: tools before invent

**Status: done**

**Files:** `skills/bringup/SKILL.md`, `config/AGENTS.md`

- [x] bringup must state ordered steps: list/describe → part → datasheet → if miss, stop (no invent)
- [x] AGENTS.md: one line — no pin/register not returned by tools this session

- [x] Commit: `docs(skills): tools-before-invent enforcement`

**Gate:** `grep -q 'never invent' skills/bringup/SKILL.md && grep -q 'labwired_part' skills/bringup/SKILL.md && grep -q 'labwired_datasheet' skills/bringup/SKILL.md`

---

## Task 5 — Confirm multi-source import on production MCP

**Status: done** (prod API after #1612)

**Repo:** monorepo (merge/deploy import PR if not live)

- [x] Confirm live `labwired_import` accepts: `diagram_json`, `bom_csv`, `text`, `pdf_text`, `kicad_sch`
- [x] If production still rejects non-diagram kinds: merge + deploy board-config/api import changes first

**Gate (session + MCP):**

```text
tools/call labwired_import { source_kind: bom_csv, board_hint: esp32-c3-supermini,
  content: "Ref,MPN,Qty\nU1,ADXL345,1\n" }
→ design_context_ok true (structuredContent)
```

Same for `kicad_sch` and `pdf_text` sample payloads (design_context_ok true).

---

## Task 6 — Agent multi-source import smoke + fixtures

**Status: done**

**Files:**

- Create `fixtures/import/sample.bom.csv`
- Create `fixtures/import/sample.pdf.txt`
- Create `fixtures/import/sample.kicad_sch`
- Create `scripts/import-multi-smoke.sh`
- Modify `scripts/ship-gate.sh` to call it

Fixtures:

```csv
Ref,MPN,Qty
U1,ADXL345,1
U2,BME280,1
```

```text
Wire ADXL345 to ESP32-C3 Super Mini over I2C. Optional SSD1306.
```

```scheme
(kicad_sch (version 20230121)
  (symbol (lib_id "Sensor:BME280") (property "Value" "BME280")))
```

- [x] Smoke: for each fixture, live MCP import OR local board-config importCircuit → `design_context_ok`
- [x] Keep existing diagram_json twin_buildable check
- [x] Commit: `test(import): multi-source import smoke`

**Gate:**

```bash
bash scripts/import-multi-smoke.sh
bash scripts/import-diagram-smoke.sh
```

Both exit 0.

---

## Task 7 — Catalog aliases for top dropped import tokens

**Files:** monorepo catalog / `board-config` `getCatalogPart` / aliases used by `import-circuit.ts`

- [ ] Run multi-import on fixtures; list `status: dropped` values
- [ ] Add aliases or part types for the top dropped names that should map (only real catalog parts)
- [ ] Re-run Task 6 until mapped count for ADXL345/BME280/ESP32 board paths is non-zero where catalog has them

**Gate:** BOM import with board_hint maps at least one of ADXL345/BME280 (mapped status), not all dropped.

---

## Task 8 — Second twin chip live-gate

**Files:** `scripts/live-gate1.sh`, fixtures under `fixtures/gate1-live/` (or sibling), systems in `share/catalog/systems/`

- [ ] Pick one additional chip with sim + ELF path (not only esp32c3)
- [ ] Red→green must produce `model_verified` for that chip
- [ ] Document `LABWIRED_GATE1_CHIP=...`

- [ ] Commit: `test(twin): live-gate second chip`

**Gate:**

```bash
LABWIRED_GATE1_CHIP=esp32c3 ./scripts/live-gate1.sh   # still green
LABWIRED_GATE1_CHIP=<second> ./scripts/live-gate1.sh  # green
```

Both exit 0.

---

## Task 9 — Physical desk E2E script (no soft pass)

**Files:** Create `scripts/desk-hw-physical.sh`

Behavior:

- If `probe-rs list` shows **no** physical probe → **exit 2** with message `NEED_PROBE` (not exit 0)
- If probe present: flash ELF from env `LABWIRED_HW_ELF` + chip `LABWIRED_HW_CHIP`, serial-capture marker `LABWIRED_HW_MARKER` (default `LABWIRED_OK`), assert JSON `status` is `hardware_observed`
- Run: `assert-status model_verified` on that JSON → must fail; `assert-status hardware_observed` → must pass

- [ ] Commit: `test(desk): physical hardware_observed hard script`

**Gate on machine with probe:**

```bash
export LABWIRED_HW_ELF=... LABWIRED_HW_CHIP=... LABWIRED_HW_PORT=...
bash scripts/desk-hw-physical.sh   # exit 0
```

**Gate on machine without probe:**

```bash
bash scripts/desk-hw-physical.sh   # exit 2, prints NEED_PROBE
```

D4 is **not done** until a named machine has exit 0 recorded (log path in PR).

---

## Task 10 — RTT capture produces same claim JSON as UART

**Files:** `lib/probe.sh`, create `lib/rtt-capture.sh` (or extend serial-capture), `skills/desk-hw/SKILL.md`, `scripts/desk-hw-smoke.sh`

- [ ] Implement capture that fills: `status`, `marker`, `excerpt`, `matched` (same fields as serial-capture)
- [ ] If probe-rs cannot RTT on this target → exit 2 `NEED_RTT` (not silent invent)
- [ ] desk-hw skill: UART or RTT both valid for marker; never invent

- [ ] Commit: `feat(desk): rtt-capture claim JSON`

**Gate:** either

```bash
labwired probe rtt-capture ...  # exit 0 + hardware_observed JSON
```

or documented hardware without RTT:

```bash
# exit 2 NEED_RTT on that target is acceptable only if UART path still exit 0 on Task 9
```

---

## Task 11 — Compose “show me X” one path

**Files:** `skills/observe/SKILL.md`, `scripts/compose-elements.py`, fixture UART

- [ ] Fixed recipe: input UART log with LED markers → output JSON with `series` or `markers` non-empty
- [ ] ship-gate already composes UART; add assert non-empty in compose step if missing
- [ ] observe skill lists element types agent may compose (serial, marker, gpio edge)

- [ ] Commit: `test(observe): compose non-empty series from UART fixture`

**Gate:**

```bash
python3 scripts/compose-elements.py --uart fixtures/gate1-live/evidence/fixed/uart.log --out /tmp/c.json
python3 -c "import json;d=json.load(open('/tmp/c.json')); assert d.get('series') or d.get('markers')"
```

---

## Task 12 — Workbench G2 checklist, no stubs as “done”

**Files:** `extensions/labwired-vscode/SHIP_CHECKLIST.md` + extension code as needed

- [ ] Walk G0 → G1 → G2; every checkbox needs evidence (command output or screenshot path in PR)
- [ ] Billing/team: open real URL or remove command — no fake success
- [ ] Golden path in extension: Install CLI → Log in → Doctor → Start Agent → same twin prove as CLI
- [ ] VSIX builds and sideloads

**Gate:** `SHIP_CHECKLIST.md` all G2 boxes `[x]` with linked evidence in the PR description. Empty checks = task not done.

---

## Task 13 — Security + self-host docs + airgap fail-closed test

**Files:**

- Create `docs/SECURITY.md`
- Create `docs/SELF_HOST.md`
- Link from README
- Create `tests/airgap-install.sh`

- [ ] SECURITY.md: tokens, prompt exfil, desk flash risk, security@labwired.com
- [ ] SELF_HOST.md: airgap profile, `LABWIRED_MCP_ENTRY`, local model, what still needs cloud
- [ ] Test: `LABWIRED_PROFILE=airgap` without MCP entry → install or doctor **fails**
- [ ] Test: with stub `mcp/vendor/index.js` present → airgap path does not fail that check

- [ ] Commit: `docs: security and self-host; airgap fail-closed test`

**Gate:**

```bash
bash tests/airgap-install.sh   # exit 0
grep -q 'security@labwired.com' docs/SECURITY.md
grep -q 'LABWIRED_MCP_ENTRY' docs/SELF_HOST.md
```

(SOC2 audit is **not** a task here — out of eng task list.)

---

## Task 14 — Dual-claim PR guard

**Files:** `.github/pull_request_template.md` (or CONTRIBUTING.md)

- [ ] Template must include:

```markdown
- [ ] Does not add instrument-farm / Open Plot product
- [ ] Does not treat desk/hardware success as twin green
- [ ] ship-gate or named smokes green for touched paths
```

- [ ] Commit: `chore: PR template dual-claim and kill-list guards`

**Gate:** file exists and contains `twin green` or `model_verified` wording about not renaming desk.

---

## Task 15 — Final ship-gate on release commit

- [ ] `./scripts/ship-gate.sh` exit 0 on the commit that claims depth waves A–C done
- [ ] Tag agent kit only after Task 2 + 6 + 8 green (minimum depth cut)
- [ ] Tag higher only after Task 9 evidence (physical) for “desk complete”

**Gate:**

```bash
./scripts/ship-gate.sh
# ends with: ship-gate PASS
```

---

## Order (strict)

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15
```

Do not start Task N+1 until Task N gate is green (or hard-blocked with named external dependency: e.g. Task 9 needs attached probe).

---

## Execution

Start at **Task 1**. Use subagent-driven or inline execution. No quarterly narrative — only task checkboxes and gates.
