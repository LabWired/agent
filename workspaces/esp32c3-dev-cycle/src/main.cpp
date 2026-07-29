#include <Arduino.h>

// Same binary for desk + twin:
// - Serial  = USB-CDC → /dev/cu.usbmodem* (desk)
// - Serial0 = UART0   → labwired-sim uart_contains (twin)
static const char *const kMarker = "LABWIRED_C3_CYCLE_OK";

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);
  delay(500);
  Serial.println(kMarker);
  Serial0.println(kMarker);
  Serial.println("chip=esp32c3");
  Serial0.println("chip=esp32c3");
  Serial.println("fw=labwired-dev-cycle-1");
  Serial0.println("fw=labwired-dev-cycle-1");
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(200);
  digitalWrite(8, LOW);
  delay(800);
  Serial.println(kMarker);
  Serial0.println(kMarker);
}
