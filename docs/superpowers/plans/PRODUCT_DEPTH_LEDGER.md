# Product Depth Ledger

**Plan:** [2026-08-12-product-depth-program.md](./2026-08-12-product-depth-program.md)  
**Rule:** Only mark `done` when the plan **Gate** command is green. Update this file in the same commit as the task work.

| Task | Title | Status | Gate evidence | Notes |
|------|-------|--------|---------------|-------|
| 1 | Required knowledge heroes file | **done** | `python3 -c assert len(required)==8` | `share/catalog/knowledge-required.json` |
| 2 | Knowledge smoke 100% required | pending | `bash scripts/knowledge-mcp-smoke.sh` | |
| 3 | Seed store until Task 2 green | pending | Task 2 exit 0 on prod | monorepo part-knowledge |
| 4 | bringup tools-before-invent | pending | grep skill/AGENTS | |
| 5 | Multi-source import on prod MCP | pending | live labwired_import bom_csv | monorepo deploy |
| 6 | Agent multi-source import smoke | pending | import-multi-smoke + diagram smoke | |
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

## Blockers

| Task | Blocker | Since |
|------|---------|-------|
| — | — | — |
