# AGENT_PRODUCT_READY claim

**Date:** 2026-07-31  
**Gate:** `labwired-agent/tests/gap-ready-qa.sh` → exit 0  
**Verdict:** **AGENT_PRODUCT_READY = yes** (scoped — see definition)

---

## Definition (honest)

**AGENT_PRODUCT_READY** means Parts 1–4 of the gap worklist are implemented and automated, and Part 5 static Editor wiring + React HW Lab build are verified:

| Included | Evidence |
|----------|----------|
| RPC debug tools (`debug_info`, `debug_gdb_*`, `debug_read`) | tool/list + plan-mode gate |
| Live `debug_read` on desk ESP32-C3 | hex words at `0x3FC88000` |
| Plot tools + offline demo plot path in UI build | `plot_status`, SerialPlotStrip in `out/` |
| Flash physical confirm gate | `probe_flash` without `confirm=1` errors |
| Claim shape + refuse `model_verified` from HW | `hw_claim_shape` |
| Promote dry-run composite | `hw_promote` dry_run → `hardware_observed` |
| Twin Gate1 `model_verified` | `labwired assert-status` on fixture |
| Editor commands + slash + contribution | static grep + ui-build |
| React build contains HW Lab plot/live | `react/out/hw-lab-tsx/index.js` |
| UX: landing starters, claim copy, agent status, flash confirm cmd | static + built JS |

**UX companion:** `2026-07-31-ux-checklist.md` — LabWired landing, slash hints, HW Lab offline banner, flash dialog, Live mem without false GDB gate.

**NOT claimed (still open product work):**

| Out of scope for this READY | Why |
|-----------------------------|-----|
| Full Electron click E2E | needs human `code.sh` session |
| GDB step / breakpoint UI | never in v1 DoD |
| STM32 powered J-Link live read | desk VTref / target power |
| Physical flash + serial promote E2E | desk only; automation is dry_run |
| Parts 6–8 | deferred (extension, catalog depth, checkpoints) |

---

## Fresh verification (2026-07-31)

```text
./tests/gap-ready-qa.sh
→ agent_product_ready: true (incl. UX static checks)
→ rpc-debug-read-live: 3fc88000: 00000000 …
```

Also green in the same session:

| Suite | Result |
|-------|--------|
| `tests/fw-usecase-qa.sh` | **33 pass / 0 fail** (`all_p0_pass: true`) |
| `tests/harness.sh` | PASS |
| `tests/skills-inventory.sh` | PASS |
| `demo.sh` | PASS |
| `tests/install-smoke.sh` | PASS |
| plotParse unit (ingestPlotLine) | PASS |
| `node --check server/rpc-server.mjs` | PASS |
| RPC synced → `~/.labwired/agent/server/rpc-server.mjs` | identical |

Gate artifact: `labwired-agent/docs/qa/gap-ready-qa-latest.json`

---

## How to re-prove

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd /Users/andrii/Projects/labwired-agent
./tests/gap-ready-qa.sh          # exit 0 required for READY
./tests/fw-usecase-qa.sh         # twin + RPC FW matrix
# optional full matrix:
LABWIRED_TEST_LLM=0 ./tests/all.sh
```

Human GUI (not required for AGENT_PRODUCT_READY):

```bash
cd /Users/andrii/Projects/labwired-cursor
./scripts/code.sh --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
# LabWired: Refresh Agent → Debug Info → /gdb info → HW Lab Demo|Live
```

---

## Related docs

- Gap worklist: `2026-07-31-gap-worklist.md`
- Missing pieces log: `2026-07-31-missing-pieces-impl.md`
- Full topic re-audit (historical FAIL/PARTIAL, then fixes): `2026-07-31-full-topic-qa-report.md`
- Smoke A–C: `2026-07-31-smoke-checklist.md`
