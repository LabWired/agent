"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveSerial = void 0;
const fs = __importStar(require("fs"));
const events_1 = require("events");
/**
 * Live UART stream for Unix serial devices (/dev/cu.*, /dev/ttyUSB*).
 * Continuous read — not one-shot capture. Windows: limited (COM open via fs).
 */
class LiveSerial extends events_1.EventEmitter {
    fd = null;
    stream = null;
    state = {
        port: "",
        baud: 115200,
        open: false,
        bytesIn: 0,
        bytesOut: 0,
    };
    getState() {
        return { ...this.state };
    }
    async open(port, baud) {
        await this.close();
        if (!port)
            throw new Error("No port");
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
        this.stream.on("data", (chunk) => {
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
    write(text) {
        if (this.fd == null)
            throw new Error("Serial not open");
        const buf = Buffer.from(text.endsWith("\n") ? text : text + "\n", "utf8");
        fs.writeSync(this.fd, buf);
        this.state.bytesOut += buf.length;
    }
    async close() {
        if (this.stream) {
            try {
                this.stream.destroy();
            }
            catch {
                /* ignore */
            }
            this.stream = null;
        }
        if (this.fd != null) {
            try {
                fs.closeSync(this.fd);
            }
            catch {
                /* ignore */
            }
            this.fd = null;
        }
        this.state.open = false;
    }
}
exports.LiveSerial = LiveSerial;
function runStty(port, baud) {
    return new Promise((resolve) => {
        const { spawn } = require("child_process");
        // macOS: stty -f PORT baud; Linux: stty -F PORT baud
        const args = process.platform === "darwin"
            ? ["-f", port, String(baud), "raw", "-echo"]
            : ["-F", port, String(baud), "raw", "-echo"];
        const child = spawn("stty", args, { stdio: "ignore" });
        child.on("close", () => resolve());
        child.on("error", () => resolve()); // non-fatal
    });
}
//# sourceMappingURL=live.js.map