# Gate 1 live twin

Real simulator path for the red→green story (not the offline JSON shapes).

| Build | UART0 text | Expected twin claim |
|-------|------------|---------------------|
| `firmware/gate1-broken.elf` | `BOOT` | `failed` |
| `firmware/gate1-fixed.elf` | `LABWIRED_OK` | `model_verified` |

Bare-metal ESP32-C3 (UART0), same twin path as core `esp32c3-blinky`.
Chip descriptor comes from **labwired-sim** (`chip: esp32c3`); system YAML is the
thin catalog entry `share/catalog/systems/esp32c3.yaml`.

```bash
# From agent repo root (needs sim + optionally riscv toolchain to rebuild ELFs)
scripts/live-gate1.sh
```

Prebuilt ELFs are committed so a machine with only `labwired-sim` can run the live gate.
Rebuild: `make -C fixtures/gate1-live/firmware`
