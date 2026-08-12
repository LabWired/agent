# Gate 1 live — STM32F103 second chip

| Build | Expected UART | Twin claim |
|-------|---------------|------------|
| `gate1-fixed.elf` | `LED ON` (Arduino blink playground fixture) | `model_verified` |
| `gate1-broken.elf` | (wrong arch / no marker) | `failed` |

```bash
LABWIRED_GATE1_CHIP=stm32f103 ./scripts/live-gate1.sh
```

Fixed ELF sourced from labwired-core `tests/fixtures/stm32f103-blinky.elf`.
Broken is intentionally non-runnable on this chip so the same oracle stays red.
