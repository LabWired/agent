/* Gate 1 broken — wrong marker (twin must stay non-model_verified). */
#include <stdint.h>
#include "c3_uart.h"

int main(void) {
  uart_puts("BOOT\n");
  for (;;) {
    uart_puts("BOOT\n");
    for (volatile uint32_t i = 0; i < 10000u; i++) {
    }
  }
}
