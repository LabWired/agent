# GPIO startup fault

The STM32F103 firmware must configure PA0 as a push-pull output, drive it high,
and print `READY` on USART1. It builds, but the GPIO requirement does not pass
on the target. Diagnose and repair the firmware. Do not change the linker
script, startup code, or required output string.
