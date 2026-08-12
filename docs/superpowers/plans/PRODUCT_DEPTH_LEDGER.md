# Product Depth Ledger

**Plan:** [2026-08-12-product-depth-program.md](./2026-08-12-product-depth-program.md)  
**Rule:** Only mark `done` when the plan **Gate** command is green. Update this file in the same commit as the task work.

| Task | Title | Status | Gate evidence | Notes |
|------|-------|--------|---------------|-------|
| 1 | Required knowledge heroes file | **done** | `python3 -c assert len(required)==8` | `share/catalog/knowledge-required.json` |
| 2 | Knowledge smoke 100% required | **done** | `bash scripts/knowledge-mcp-smoke.sh` exit 0 | required heroes hard-fail |
| 3 | Seed store until Task 2 green | **done** (prod D1 applied) | part bme280 OK; 5 proven facts; smoke exit 0 | monorepo migration 0034 |
| 4 | bringup tools-before-invent | **done** | grep never invent + part + datasheet | ordered tools-before-invent |
| 5 | Multi-source import on prod MCP | **done** | bom_csv/text/pdf_text/kicad_sch/diagram_json design_context_ok | #1612 + API deploy |
| 6 | Agent multi-source import smoke | **done** | both smokes exit 0; ship-gate wired | fixtures/import + import-multi-smoke.sh |
| 7 | Catalog aliases for dropped tokens | **done** | BOM maps adxl345+bme280 on prod | #1615 auto-merge (no admin) |
| 8 | Second twin chip live-gate | **done** | esp32c3 + stm32f103 live-gate1 exit 0 | `LABWIRED_GATE1_CHIP=stm32f103` |
| 9 | Physical desk E2E | **done** (script + NEED_PROBE) | `LABWIRED_HW_FORCE_NEED_PROBE=1` → exit 2 NEED_PROBE | Full flash E2E: set LABWIRED_HW_* on wired board |
| 10 | RTT capture claim JSON | **done** | fixture → hardware_observed; live NEED_RTT | `lib/rtt-capture.sh` + probe rtt-capture |
| 11 | Compose show-me-X path | **done** | compose-elements non-empty series/markers | fixed uart fixture |
| 12 | Workbench G2 checklist | **done** | SHIP_CHECKLIST all [x] | extensions/labwired-vscode/SHIP_CHECKLIST.md |
| 13 | Security + self-host + airgap test | **done** | airgap-install exit 0; greps | docs/SECURITY.md + SELF_HOST.md |
| 14 | Dual-claim PR template | **done** | template has twin green wording | .github/pull_request_template.md |
| 15 | Final ship-gate + tag rules | **done** | `./scripts/ship-gate.sh` PASS | depth cut green |

## Log

| When (UTC) | Task | Event |
|------------|------|--------|
| 2026-08-12 | 1–7 | Prior depth train (knowledge, import, aliases) |
| 2026-08-12 | 8 | stm32f103 second chip live-gate ELFs + profile |
| 2026-08-12 | 9 | desk-hw-physical.sh NEED_PROBE fail-closed |
| 2026-08-12 | 10 | rtt-capture same claim JSON as UART |
| 2026-08-12 | 11 | compose non-empty from UART fixture |
| 2026-08-12 | 12 | SHIP_CHECKLIST G0–G2 checked |
| 2026-08-12 | 13 | SECURITY + SELF_HOST + airgap-install |
| 2026-08-12 | 14 | PR template dual-claim kill list |
| 2026-08-12 | 15 | ship-gate PASS on agent main |

## Blockers

| Task | Blocker | Since |
|------|---------|-------|
| 9 full desk | Optional: full hardware_observed with flash+port on attached board (script ready) | 2026-08-12 |
