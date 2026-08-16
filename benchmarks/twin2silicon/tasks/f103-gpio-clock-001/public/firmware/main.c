#include <stdint.h>
#define REG32(a) (*(volatile uint32_t *)(a))
#define RCC_APB2ENR REG32(0x40021018u)
#define GPIOA_CRL REG32(0x40010800u)
#define GPIOA_ODR REG32(0x4001080cu)
#define USART1_SR REG32(0x40013800u)
#define USART1_DR REG32(0x40013804u)
#define USART1_CR1 REG32(0x4001380cu)

static void putc(char c) {
    while ((USART1_SR & (1u << 7)) == 0u) {}
    USART1_DR = (uint32_t)(uint8_t)c;
}

int main(void) {
    RCC_APB2ENR |= (1u << 14);
    USART1_CR1 = (1u << 13) | (1u << 3);
    GPIOA_CRL = (GPIOA_CRL & ~0xfu) | 0x3u;
    GPIOA_ODR |= 1u;
    if ((GPIOA_CRL & 0xfu) == 0x3u && (GPIOA_ODR & 1u) != 0u) {
        const char *s = "READY\n";
        while (*s) putc(*s++);
    }
    for (;;) {}
}
