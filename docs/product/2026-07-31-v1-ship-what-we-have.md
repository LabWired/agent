# V1 Ship Rule: What We Have — Super Well Tested

**Date:** 2026-07-31  
**Status:** Binding product rule for first customer-facing release  
**Supersedes for ship order:** SOTA design is **roadmap only** until V1 is certified

---

## The rule (one sentence)

> **First version we ship is only what already works and is automated-green — not the SOTA mission board, RTT, or evidence graph.**

SOTA design (`docs/superpowers/specs/2026-07-31-sota-fw-engineer-platform-design.md`) stays the **north star**.  
It does **not** gate V1. V1 is the **AGENT_PRODUCT_READY** surface, hardened and re-proven.

---

## Why

| Temptation | Why we refuse it for V1 |
|------------|-------------------------|
| Ship missions + timeline first | New code, half-wired evidence path, unproven E2E |
| Ship RTT/defmt | Not implemented in agent; matrix unvalidated |
| Ship “full GUI product ready” | Electron click E2E never automated |
| Expand scope during polish | Breaks trust; false READY already burned us once |

Firmware engineers prefer a **small, honest, reliable** kit over a visionary demo that fails on desk.

---

## V1 product definition (in scope)

### Agent (`labwired-agent`)

| Capability | V1 claim |
|------------|----------|
| JSON-RPC server (`rpc-server.mjs`) | Works; protocol 0.5.0 |
| Twin Gate1 offline → `model_verified` | Automated green |
| Dual claims: refuse `model_verified` from HW | Automated green |
| `hardware_observed` shape + promote **dry_run** | Automated green |
| Physical flash requires `confirm=1` | Automated green |
| Plan blocks destructive flash tools | Automated green |
| Debug tools + live `debug_read` (esp32c3 when probe present) | Automated when hardware present; graceful fail otherwise |
| Plot status / slash `/gdb` `/plot` `/promote` | Automated green |
| Skills present (9) + AGENTS vocabulary | Automated green |
| Doctor / install / harness | Automated green |

### Editor (`labwired-cursor`)

| Capability | V1 claim |
|------------|----------|
| Thin shell → agent channel | Static + agent ready path |
| LabWired F1 commands (sign-in, refresh, debug, flash-confirm, HW Lab, Evidence) | Static registered |
| Slash matrix (doctor, probe, gdb, plot, promote, FW skills prompts) | Source + UX copy |
| HW Lab: targets, demo, plot offline, Live UART UI, Live registers | Built React out; demo path offline |
| Claim vocabulary in empty chat | Shipped |
| Agent offline CTA | Shipped |

### Explicitly **out of V1** (roadmap / SOTA)

- Mission Board / `mission/*` RPC  
- Evidence Timeline / claim graph  
- RTT/defmt product path  
- `twin_verify` as new RPC product surface (use existing assert/fixtures)  
- Zephyr/ESP-IDF mission packs  
- Physical promote E2E automation  
- Full GDB step/BP UI  
- “FULL_GUI_PRODUCT_READY”  

---

## V1 certification gates (must all pass)

Run from a clean shell:

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd ~/Projects/labwired-agent

# Core — must exit 0
./tests/gap-ready-qa.sh          # agent_product_ready: true
./tests/fw-usecase-qa.sh         # all_p0_pass: true
LABWIRED_TEST_LLM=0 ./tests/all.sh   # OVERALL PASS

# Optional but recommended before tag
labwired doctor                  # ready
labwired assert-status model_verified fixtures/gate1/artifacts/fixed.verify.json
```

Editor (static / build — no false GUI claim):

```bash
cd ~/Projects/labwired-cursor
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
npm run buildreact               # exit 0
# gap-ready already greps commands + slash + SerialPlotStrip in out/
```

### V1 human smoke (manual, 10 min — document results, do not invent PASS)

Checklist: `docs/superpowers/plans/2026-07-31-ux-checklist.md`

1. `./scripts/code.sh …` launches  
2. **LabWired: Refresh Agent** → ready  
3. Chat `/doctor`  
4. HW Lab → **Run demo** → plot moves  
5. (If ESP attached) Registers → Live → Refresh  
6. Cancel or virtual path on **Flash with confirm**  

**Rule:** Human smoke failures block marketing “works in the Editor” language — not the agent kit tag if agent gates are green. Be precise in release notes.

---

## V1 release notes template (honest)

```markdown
## LabWired V1 — Agent + thin Editor shell

### Works
- Twin Gate1 claim gates (model_verified / failed)
- Dual claim vocabulary (twin vs desk)
- Agent RPC tools: doctor, probe, flash (confirm), promote dry_run, debug_read, plot
- Editor: agent chat slash tools, HW Lab demo + serial UI, Evidence pane (list), LabWired commands

### Does not claim
- Full mission board / evidence graph (roadmap)
- RTT/defmt (roadmap)
- Automatic physical promote E2E
- GDB step debugger UI
- Every board powered on every desk

### How we tested
- gap-ready-qa: N/N
- fw-usecase-qa: N/N  
- all.sh: PASS
- Human Editor smoke: [date / result]
```

---

## What we may still fix *before* V1 tag (hardening only)

Only if it **reduces risk** of what we already ship — not new product surfaces:

| Allowed pre-V1 | Disallowed pre-V1 |
|----------------|-------------------|
| Bugfixes for flash confirm / mode gate holes that affect safety | Mission Board |
| Test harness coverage for existing tools | Evidence Timeline redesign |
| Docs / release notes / install clarity | RTT implementation |
| `hw_promote` Plan denylist if safety-critical | Twin_verify mission engine |
| Sync `rpc-server.mjs` → `~/.labwired` | New slash missions product |

**Safety exception:** If Plan mode can still flash via `hw_promote` (known gap in SOTA review), a **minimal denylist fix + harness** is allowed as V1.0.1-class hardening without shipping missions.

---

## Version naming

| Tag | Meaning |
|-----|---------|
| **V1 / AGENT_PRODUCT_READY** | This document — ship |
| **V1.x** | Hardening only |
| **V2 / SOTA P0.a** | First roadmap slice after V1 is out and stable |

Do not rename V1 to “SOTA platform.”

---

## Relationship to SOTA design

```text
V1 SHIP  ──►  what exists + automated green + honest notes
                │
                │  (after customers can trust V1)
                ▼
SOTA P0.a ──►  safety + evidence + twin-green mission + CI recipe
SOTA P0.b+ ─►  RTT, more missions, platforms
```

SOTA design remains approved as **direction**.  
**Ship order is overridden by this V1 rule.**

---

## Owner checklist before “we shipped”

- [ ] `gap-ready-qa.sh` exit 0, artifact saved under `labwired-agent/docs/qa/`  
- [ ] `fw-usecase-qa.sh` exit 0  
- [ ] `all.sh` OVERALL PASS (LLM suite skipped OK if documented)  
- [ ] RPC synced to installed agent home  
- [ ] Release notes use V1 template (no false GUI/SOTA claims)  
- [ ] Human smoke logged (pass/fail/skip with reason)  
- [ ] SOTA roadmap not marketed as included  

**Only then:** tag / announce V1.
