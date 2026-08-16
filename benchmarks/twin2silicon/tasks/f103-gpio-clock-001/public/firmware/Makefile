BUILD_DIR := build
CROSS ?= arm-none-eabi-
CC := $(CROSS)gcc
CFLAGS := -mcpu=cortex-m3 -mthumb -ffreestanding -fno-builtin -ffunction-sections -fdata-sections -Os -g -Wall -Wextra -Werror
LDFLAGS := -nostdlib -T bench.ld -Wl,--gc-sections
all: $(BUILD_DIR)/firmware.elf
$(BUILD_DIR):
	mkdir -p $@
$(BUILD_DIR)/firmware.elf: startup.c main.c bench.ld | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(LDFLAGS) startup.c main.c -o $@
clean:
	rm -rf $(BUILD_DIR)
.PHONY: all clean
