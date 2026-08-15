#include <stdio.h>

#include "driver/gpio.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "run_nonce.h"

#define TEST_GPIO GPIO_NUM_2

void app_main(void)
{
    ESP_ERROR_CHECK(gpio_set_direction(TEST_GPIO, GPIO_MODE_INPUT));
    ESP_ERROR_CHECK(gpio_set_level(TEST_GPIO, 1));

    for (;;) {
        printf("LABWIRED_READY:%s\n", LABWIRED_RUN_NONCE);
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
