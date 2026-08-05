import * as fs from "fs";
import { EventEmitter } from "events";

export type SerialLiveState = {
  port: string;
  baud: number;
  open: boolean;
  bytesIn: number;
  bytesOut: number;
};

/**
 * Live UART stream for Unix serial devices (/dev/cu.*, /dev/ttyUSB*).
 * Continuous read — not one-shot capture. Windows: limited (COM open via fs).
 */
export class LiveSerial extends EventEmitter {
  private fd: number | null = null;
  private stream: fs.ReadStream | null = null;
  private state: SerialLiveState = {
    port: "",
    baud: 115200,
    open: false,
    bytesIn: 0,
    bytesOut: 0,
  };

  getState(): SerialLiveState {
    return { ...this.state };
  }

  async open(port: string, baud: number): Promise<void> {
    await this.close();
    if (!port) throw new Error("No port");

    // Configure baud on macOS/Linux via stty when possible
    if (process.platform === "darwin" || process.platform === "linux") {
      await runStty(port, baud);
    }

    this.fd = fs.openSync(port, "r+");
    this.stream = fs.createReadStream("", {
      fd: this.fd,
      autoClose: false,
      encoding: "utf8",
      highWaterMark: 4096,
    });

    this.state = {
      port,
      baud,
      open: true,
      bytesIn: 0,
      bytesOut: 0,
    };

    this.stream.on("data", (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.state.bytesIn += Buffer.byteLength(s);
      this.emit("data", s);
    });
    this.stream.on("error", (err) => {
      this.emit("error", err);
      void this.close();
    });
    this.stream.on("close", () => {
      this.state.open = false;
      this.emit("close");
    });
    this.emit("open", this.getState());
  }

  write(text: string): void {
    if (this.fd == null) throw new Error("Serial not open");
    const buf = Buffer.from(text.endsWith("\n") ? text : text + "\n", "utf8");
    fs.writeSync(this.fd, buf);
    this.state.bytesOut += buf.length;
  }

  async close(): Promise<void> {
    if (this.stream) {
      try {
        this.stream.destroy();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    this.state.open = false;
  }
}

function runStty(port: string, baud: number): Promise<void> {
  return new Promise((resolve) => {
    const { spawn } = require("child_process") as typeof import("child_process");
    // macOS: stty -f PORT baud; Linux: stty -F PORT baud
    const args =
      process.platform === "darwin"
        ? ["-f", port, String(baud), "raw", "-echo"]
        : ["-F", port, String(baud), "raw", "-echo"];
    const child = spawn("stty", args, { stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // non-fatal
  });
}
