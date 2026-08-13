CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror

.PHONY: all
all: firmware

firmware: main.c
	$(CC) $(CFLAGS) main.c -o firmware
