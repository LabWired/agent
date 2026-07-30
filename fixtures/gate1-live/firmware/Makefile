# Bare-metal ESP32-C3 Gate 1 ELFs for live twin (copied pattern from core blinky).
# Toolchain: riscv32-esp-elf-gcc (PlatformIO or ESP-IDF).

ifneq ($(origin CC),command line)
DISCOVERED_CC := $(shell command -v riscv32-esp-elf-gcc 2>/dev/null)
ifeq ($(strip $(DISCOVERED_CC)),)
DISCOVERED_CC := $(firstword $(wildcard \
        $(HOME)/.platformio/packages/toolchain-riscv32-esp/bin/riscv32-esp-elf-gcc \
        $(HOME)/.platformio/tools/toolchain-riscv32-esp/bin/riscv32-esp-elf-gcc \
        $(HOME)/.espressif/tools/riscv32-esp-elf/*/riscv32-esp-elf/bin/riscv32-esp-elf-gcc))
endif
CC := $(DISCOVERED_CC)
endif

# Older PIO toolchains reject _zicsr_zifencei; plain rv32imc is enough for twin.
CFLAGS  := -march=rv32imc -mabi=ilp32 -ffreestanding -O2 -g \
           -Wall -Wextra -ffunction-sections -fdata-sections -I.
LDFLAGS := -march=rv32imc -mabi=ilp32 -nostartfiles \
           -Wl,--gc-sections -T c3.ld -lgcc

COMMON := startup.S c3_uart.c

.PHONY: all clean fixed broken

all: fixed broken

fixed: gate1-fixed.elf
broken: gate1-broken.elf

gate1-fixed.elf: $(COMMON) main_fixed.c c3.ld
	@if [ -z "$(strip $(CC))" ]; then \
	  echo "ERROR: riscv32-esp-elf-gcc not found"; exit 1; fi
	$(CC) $(CFLAGS) $(COMMON) main_fixed.c $(LDFLAGS) -o $@

gate1-broken.elf: $(COMMON) main_broken.c c3.ld
	@if [ -z "$(strip $(CC))" ]; then \
	  echo "ERROR: riscv32-esp-elf-gcc not found"; exit 1; fi
	$(CC) $(CFLAGS) $(COMMON) main_broken.c $(LDFLAGS) -o $@

clean:
	rm -f gate1-fixed.elf gate1-broken.elf *.o
