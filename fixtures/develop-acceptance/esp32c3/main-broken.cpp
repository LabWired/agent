#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, !digitalRead(8));
  Serial.println("alive")
  delay(1000);
}
