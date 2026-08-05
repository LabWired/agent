# Reverse-step demo (same binary as verify)

**Goal:** Show LabWired ★ path Embedder cannot match: twin **`model_verified`**
on a binary, then **F5 reverse-step** the same firmware in the MIT debugger.

Sim is not required for all work — but this demo uses twin + DAP when available.

---

## Prerequisites

- Agent kit with sim (or hosted twin tools)
- LabWired VS Code debugger extension (`labwired-vscode`) for reverse-step
- Gate1 live ELFs or your own verified `firmware_ref`

---

## Scripted twin half (automated)

```bash
# From labwired-agent checkout
./scripts/live-gate1.sh
# fixed → model_verified; UART contains LABWIRED_OK

# Dual-claim report (HW not run)
python3 scripts/report-evidence.py \
  --twin fixtures/gate1-live/evidence/fixed/result.json \
  --out /tmp/gate1-report.md \
  --require-evidence-on-green || true

# Offline artifact shape
python3 scripts/report-evidence.py \
  --twin fixtures/gate1/artifacts/fixed.verify.json \
  --out /tmp/offline-report.md \
  --require-evidence-on-green
```

Use the **fixed** ELF:

`fixtures/gate1-live/firmware/gate1-fixed.elf`

---

## Debugger half (human in VS Code — not video)

1. Open a project that can load the same ELF / rebuild same sources.  
2. **LabWired: Start Debugging** (F5) against the twin DAP configuration.  
3. Run to a breakpoint after UART marker / main loop.  
4. Use **reverse-step** / reverse continue (twin DAP) on the **same binary**.  
5. Inspect registers / call stack — do **not** re-label this as a new
   `model_verified` (that already came from verify/live-gate1).

### Honest claims

| Step | Claim |
|------|--------|
| live-gate1 / `labwired_verify` green | `model_verified` |
| F5 reverse-step | Debug observation only |
| Physical flash + marker | `hardware_observed` only |

---

## Agent skill pointers

- `verify-firmware` → mint twin green  
- `report-evidence` → dual-claim footer (never upgrade HW→twin)  
- `golden-path` → prefer twin when available; debugger first-class if not  

---

## Done when

- [x] Automated twin red/green for same beachhead (live-gate1)  
- [x] Report script forces dual-claim language  
- [ ] Engineer once walks F5 reverse-step on gate1-fixed.elf in VS Code (human, no video required for eng exit)
