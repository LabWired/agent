# Product Depth Ledger

**Plan:** [2026-08-12-product-depth-program.md](./2026-08-12-product-depth-program.md)  
**Rule:** Only mark `done` when the plan **Gate** command is green. Update this file in the same commit as the task work.

| Task | Title | Status | Gate evidence | Notes |
|------|-------|--------|---------------|-------|
| 1 | Required knowledge heroes file | **done** | `python3 -c assert len(required)==8` | `share/catalog/knowledge-required.json` |
| 2 | Knowledge smoke 100% required | **done** | `bash scripts/knowledge-mcp-smoke.sh` exit 0 | required heroes hard-fail |
| 3 | Seed store until Task 2 green | **done** (prod D1 applied) | part bme280 OK; 5 proven facts; smoke exit 0 | monorepo #1613 + migration 0034 |
| 4 | bringup tools-before-invent | **done** | grep never invent + part + datasheet | ordered tools-before-invent |
| 5 | Multi-source import on prod MCP | **done** | bom_csv/text/pdf_text/kicad_sch/diagram_json design_context_ok | #1612 merged + API deploy |
| 6 | Agent multi-source import smoke | **done** | both smokes exit 0; ship-gate wired | fixtures/import + import-multi-smoke.sh |
| 7 | Catalog aliases for dropped tokens | pending | BOM maps ADXL345/BME280 | |
| 8 | Second twin chip live-gate | pending | two LABWIRED_GATE1_CHIP green | |
| 9 | Physical desk E2E | pending | desk-hw-physical exit 0 w/ probe | exit 2 if NEED_PROBE |
| 10 | RTT capture claim JSON | pending | rtt-capture or NEED_RTT + Task 9 | |
| 11 | Compose show-me-X path | pending | compose-elements non-empty | |
| 12 | Workbench G2 checklist | pending | SHIP_CHECKLIST all [x] + evidence | |
| 13 | Security + self-host + airgap test | pending | airgap-install.sh exit 0 | |
| 14 | Dual-claim PR template | pending | template file exists | |
| 15 | Final ship-gate + tag rules | pending | ship-gate PASS | |

## Log

| When (UTC) | Task | Event |
|------------|------|--------|
| 2026-08-12 | 1 | Created knowledge-required.json (8 heroes); ledger opened |
| 2026-08-12 | 2 | knowledge-mcp-smoke enforces knowledge-required.json; live run fails only on bme280 part |
| 2026-08-12 | 3 | Applied 0034_part_knowledge_bme280 on prod D1; labwired_part bme280 OK (5 proven); smoke PASS |
| 2026-08-12 | 2 | knowledge-mcp-smoke exit 0 on prod session (required heroes + canaries) |
| 2026-08-12 | 4 | bringup/AGENTS tools-before-invent; gate greps green |
| 2026-08-12 | 5 | #1612 merged (TS fix); API worker deployed; multi-source import green on prod |
| 2026-08-12 | 6 | import-multi-smoke + fixtures; ship-gate 10b; both gates exit 0 |

## Blockers

| Task | Blocker | Since |
|------|---------|-------|
| — | — | — |
