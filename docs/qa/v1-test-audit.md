# V1 proper test audit — what works vs what is still missing

**Date:** 2026-07-31  
**Rule:** Ship only super-tested surface; list holes honestly.  
**Related:** `2026-07-31-v1-ship-what-we-have.md`

---

## Executive verdict

| Layer | Automated | Honest product status |
|-------|-----------|------------------------|
| **Agent RPC + claims + twin Gate1** | **Strong** | Ready for V1 *agent kit* ship |
| **Editor static wiring + React build** | **Medium** | Wired; **not** Electron E2E certified |
| **Desk physical promote / full GUI** | **Weak / not run** | **Do not claim** |
| **SOTA surfaces (missions, timeline, RTT)** | N/A | **Not in V1** — still missing by design |

**Bottom line:** We are **not** “product complete.” We **are** green on the **agent tooling + claim gates** we defined as V1. Many user-facing and future parts are still missing or untested.

---

## Fresh test results (this audit)

| Suite | Result |
|-------|--------|
| `tests/gap-ready-qa.sh` | **exit 0** (`agent_product_ready: true`) — includes Plan blocks `hw_promote` after fix |
| `tests/fw-usecase-qa.sh` | **34 pass / 0 fail** (added FW-SAFE-01b) |
| `LABWIRED_TEST_LLM=0 ./tests/all.sh` | **OVERALL PASS** (pre-safety-fix run; re-run after fix recommended) |
| Adversarial RPC audit | **Found Plan/`hw_promote` hole → fixed** |
| Live `debug_read` esp32c3 | **PASS** (when probe attached) |
| `labwired doctor` | **ready** |

### Safety fix applied during audit

| Hole | Before | After |
|------|--------|-------|
| Plan mode + `hw_promote` | **FAIL** — nested flash path ran (usage error on elf) | **PASS** — Plan denylist includes `hw_promote` |
| Harness | gap-ready / fw-usecase lacked promote gate | **FW-SAFE-01b** + `rpc-plan-hw-promote` (+ dry) |

File: `labwired-agent/server/rpc-server.mjs` (`destructive` set).  
Synced to `~/.labwired/agent/server/rpc-server.mjs`.

---

## What is tested green (V1 agent)

- Twin Gate1 offline → `model_verified` / broken → `failed`
- Refuse `model_verified` from HW claim shape
- `hardware_observed` claim shape
- `probe_flash` needs `confirm=1` for physical
- Plan blocks `probe_flash` **and** `hw_promote`
- Verify blocks `install_deps`
- Promote **dry_run** → `hardware_observed` text
- Chat slash `/gdb` `/promote` (tool source)
- Debug tools listed; plan blocks GDB start
- `debug_read` live words on esp32c3 (desk)
- Plot tools; serial listPorts
- 9 skills present + AGENTS vocabulary
- Install smoke + harness + doctor

---

## What is still MISSING or WEAK (do not pretend)

### A. Safety / correctness residual

| Gap | Severity | Notes |
|-----|----------|-------|
| Nested `hw_promote` flash does not re-enter `toolRun` assert | **Med** | Plan now blocks whole tool; nested path still bypasses for Act (OK). Ideal: shared `assertToolAllowed` |
| OpenCode `chat/send` freeform has broader tool surface than RPC allowlist | **Med** | Trust boundary for “agent skills” path |
| `LABWIRED_FLASH_AUTO=1` can still override confirm | **Med** | Env footgun; editor must never set |

### B. Evidence / Editor product gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Evidence auto-ingest **misses** `hw_*` / promote tools | **High for UX** | Regex only `score\|assert\|smoke\|verify\|doctor` |
| `chat/toolResult` events drop `extra` | **High for UX** | RPC result has `extra`; editor event type has no `extra` |
| Evidence = flat list, not claim graph / dual columns | **High** | SOTA P0.a — not V1 |
| Two Evidence UIs (DOM pane + evidence-tsx) | **Med** | Consistency risk |
| No Electron click E2E | **High for “Editor works” claim** | Human smoke only |
| Channel path is `electron-main/labwiredAgentChannel.ts` (not under `common/`) | **Nit** | Docs/path confusion |

### C. Live lab / hardware

| Gap | Severity | Notes |
|-----|----------|-------|
| RTT / defmt | **Missing** | No RPC tools |
| STM32 powered live read | **Desk dependent** | VTref / power |
| Physical flash + serial promote E2E | **Not automated** | dry_run only |
| Multi-probe UX polish | **Partial** | code path improved for esp |
| GDB step / breakpoints UI | **Missing** | Out of V1 |

### D. Twin / CI productization

| Gap | Severity | Notes |
|-----|----------|-------|
| No `twin_verify` RPC tool | **Missing** | MCP/chat/fixtures today |
| No customer GitHub Action recipe as product | **Missing** | Gate1 scripts exist for us |
| Mission Board / `mission/*` | **Missing** | SOTA |

### E. Skills / platforms

| Gap | Severity | Notes |
|-----|----------|-------|
| Skill quality = file inventory, not HIL pass rates | **Med** | Research: expert skills need HIL proof |
| Zephyr / ESP-IDF mission depth | **Thin** | Skills text, not full packs |
| Catalog 22 systems vs runnable missions | **Partial** | HW Lab catalog ≠ verified agent jobs |

---

## What “proper test” still requires before *Editor* V1 marketing

1. **Human smoke log** (`2026-07-31-ux-checklist.md`) with date — launch `code.sh`, doctor, demo plot, optional live regs  
2. Re-run `all.sh` **after** Plan/`hw_promote` fix (confirm overall still green)  
3. Optional: extend evidence ingest for `hw_claim` / `hw_promote` **if** we claim Evidence pane works for desk claims  

Agent kit can ship with (1) optional if release notes say “agent CLI/RPC primary.”

---

## Recommended next actions (ordered)

| # | Action | Type |
|---|--------|------|
| 1 | Re-run `LABWIRED_TEST_LLM=0 ./tests/all.sh` post-fix | Verify |
| 2 | Human Editor smoke → log in smoke-log.md | Verify |
| 3 | V1 release notes: **agent-strong, Editor partial** | Docs |
| 4 | (Optional harden) evidence ingest + forward `extra` for hw tools | Small fix |
| 5 | **Do not** start Mission Board until V1 certified | Process |

---

## Gate commands (copy-paste)

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd ~/Projects/labwired-agent
./tests/gap-ready-qa.sh
./tests/fw-usecase-qa.sh
LABWIRED_TEST_LLM=0 ./tests/all.sh
labwired doctor
```

---

## Honesty statement for stakeholders

> Automated agent gates are green after fixing a real Plan-mode promote hole found by adversarial testing.  
> We still miss missions, evidence timeline, RTT, physical promote E2E, and Electron E2E.  
> **V1 = tested agent + thin editor wiring — not the full SOTA platform.**
