# Multi-chip twin prove fix — 2026-07-29/30

## Shipped
| PR | Fix |
|----|-----|
| #1101 | Embed rp2040 + nrf52840 CHIP_YAMLS; map RP2040 GPIO→sio |
| #1102 | Bare-ELF maxSteps 1e6 → 20e6 for Arduino bring-up |

## Root causes fixed
1. **No chip descriptor** for Pico/nRF → `prepareRunTarget` aborted before twin run
2. **RP2040 pin map** used peripheral `gpio` but chip uses `sio`
3. **Step budget** too low for Arduino CRT/Serial on Cortex-M

## Live after deploy
- C3 LED: **Verified live** ✅
- Pico/nRF/STM32: no more DIAGRAM_INVALID; still `proven:false` after run_and_verify
- STM32 shows `auto_markers: ["LED ON"]` — oracle path OK; twin serial still empty/mismatch

## Remaining (twin/firmware fidelity)
Hosted Arduino sketches for Pico (USB CDC Serial), nRF, STM32 still do not emit matching UART serial under the builder twin. Next: capture builder `/run` serial excerpts + compile diags for L0_serial_boot matrix sketches on these chips.
