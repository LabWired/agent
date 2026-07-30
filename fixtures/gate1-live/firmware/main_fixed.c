/* Gate 1 fixed — prints oracle marker over UART0 (twin-visible). */
#include <stdint.h>
#include "c3_uart.h"

int main(void) {
  uart_puts("LABWIRED_OK\n");
  for (;;) {
    uart_puts("LABWIRED_OK\n");
    for (volatile uint32_t i = 0; i < 10000u; i++) {
    }
  }
}
