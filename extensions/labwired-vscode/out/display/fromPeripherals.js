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
exports.extractDisplayFromPeripherals = extractDisplayFromPeripherals;
exports.extractDisplayFromRunJson = extractDisplayFromRunJson;
exports.extractSnapshotId = extractSnapshotId;
exports.findRunJsonCandidates = findRunJsonCandidates;
exports.writeDisplayLatest = writeDisplayLatest;
/**
 * Extract display frames from labwired_run / labwired_inspect peripheral walls.
 * Shape matches builder InspectArtifact: { kind, id, meta, bytes? }.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function asBytes(raw) {
    if (!raw)
        return undefined;
    if (typeof raw === "string") {
        try {
            return Uint8Array.from(Buffer.from(raw, "base64"));
        }
        catch {
            return undefined;
        }
    }
    if (Array.isArray(raw) && raw.length) {
        return Uint8Array.from(raw.map((n) => n & 0xff));
    }
    return undefined;
}
function metaNum(meta, keys) {
    if (!meta)
        return undefined;
    for (const k of keys) {
        const v = meta[k];
        if (typeof v === "number" && Number.isFinite(v))
            return v;
        if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))
            return Number(v);
    }
    return undefined;
}
function guessFormat(kind, id, len, w, h) {
    const tag = `${kind} ${id}`.toLowerCase();
    if (tag.includes("ssd1306") ||
        tag.includes("sh1107") ||
        tag.includes("pcd8544") ||
        tag.includes("oled")) {
        if (len === 1024)
            return { format: "ssd1306_page", width: 128, height: 64 };
        if (len === 512)
            return { format: "ssd1306_page", width: 128, height: 32 };
        if (len === 2048)
            return { format: "ssd1306_page", width: 128, height: 128 };
        if (w && h && len === (w * h) / 8) {
            return { format: "ssd1306_page", width: w, height: h };
        }
    }
    if (tag.includes("ili9341") ||
        tag.includes("st7789") ||
        tag.includes("rgb565") ||
        tag.includes("framebuffer")) {
        if (w && h && len === w * h * 2) {
            return { format: "rgb565_be", width: w, height: h };
        }
        if (len === 240 * 320 * 2)
            return { format: "rgb565_be", width: 240, height: 320 };
        if (len === 320 * 240 * 2)
            return { format: "rgb565_be", width: 320, height: 240 };
    }
    if (w && h) {
        if (len === w * h)
            return { format: "raw_gray", width: w, height: h };
        if (len === w * h * 2)
            return { format: "rgb565_be", width: w, height: h };
        if (len === (w * h) / 8)
            return { format: "ssd1306_page", width: w, height: h };
    }
    if (len % 128 === 0 && len <= 2048) {
        const pages = len / 128;
        return { format: "ssd1306_page", width: 128, height: pages * 8 };
    }
    return { format: "unknown", width: w || 128, height: h || 64 };
}
function isDisplayArtifact(a) {
    const tag = `${a.kind || ""} ${a.id || ""}`.toLowerCase();
    return (tag.includes("framebuffer") ||
        tag.includes("ssd1306") ||
        tag.includes("sh1107") ||
        tag.includes("pcd8544") ||
        tag.includes("ili9341") ||
        tag.includes("st7789") ||
        tag.includes("epaper") ||
        tag.includes("display") ||
        tag.includes("panel") ||
        tag.includes("led_matrix") ||
        tag.includes("led-matrix"));
}
/** Pull best display frame from a peripherals wall (run/inspect result). */
function extractDisplayFromPeripherals(peripherals, opts) {
    if (!Array.isArray(peripherals))
        return undefined;
    const preferBytes = opts?.preferWithBytes !== false;
    let metaOnly;
    for (const raw of peripherals) {
        const arts = raw?.artifacts;
        if (!Array.isArray(arts))
            continue;
        for (const a of arts) {
            if (!isDisplayArtifact(a))
                continue;
            const meta = (a.meta || {});
            const kind = String(a.id || a.kind || "display");
            const w = metaNum(meta, ["width", "w", "cols", "columns"]);
            const h = metaNum(meta, ["height", "h", "rows"]);
            const ink = metaNum(meta, [
                "ink_bytes",
                "black_ink_bytes",
                "painted_bytes",
            ]);
            const total = metaNum(meta, ["total_bytes", "black_total_bytes"]);
            const gen = metaNum(meta, ["refresh_generation", "generation", "gen"]);
            const bytes = asBytes(a.bytes);
            if (!bytes || !bytes.length) {
                if (!metaOnly) {
                    metaOnly = {
                        kind,
                        width: w || 128,
                        height: h || 64,
                        format: "unknown",
                        pixelBase64: "",
                        label: `${kind} (meta only — inspect with output=peripherals/full for pixels)`,
                        peripheral: raw.name,
                        artifactId: a.id,
                        meta,
                        metaOnly: true,
                        inkBytes: ink,
                        totalBytes: total,
                        refreshGeneration: gen,
                    };
                }
                continue;
            }
            const guessed = guessFormat(String(a.kind || ""), kind, bytes.length, w, h);
            const frame = {
                kind,
                width: guessed.width,
                height: guessed.height,
                format: guessed.format,
                pixelBase64: Buffer.from(bytes).toString("base64"),
                label: `${kind} ${guessed.width}×${guessed.height} · ${guessed.format}${gen != null ? ` · gen ${gen}` : ""}${ink != null ? ` · ink ${ink}` : ""}`,
                peripheral: raw.name,
                artifactId: a.id,
                meta,
                inkBytes: ink,
                totalBytes: total,
                refreshGeneration: gen,
            };
            if (guessed.format === "ssd1306_page") {
                frame.monoBase64 = frame.pixelBase64;
            }
            if (preferBytes)
                return frame;
        }
    }
    return metaOnly;
}
/** Walk a run/inspect/verify JSON blob for peripherals (several nesting shapes). */
function extractDisplayFromRunJson(json) {
    if (!json || typeof json !== "object")
        return undefined;
    const o = json;
    let hit = extractDisplayFromPeripherals(o.peripherals);
    if (hit)
        return hit;
    if (o.result && typeof o.result === "object") {
        hit = extractDisplayFromRunJson(o.result);
        if (hit)
            return hit;
    }
    if (o.run && typeof o.run === "object") {
        hit = extractDisplayFromRunJson(o.run);
        if (hit)
            return hit;
    }
    if (Array.isArray(o.content)) {
        for (const c of o.content) {
            if (typeof c?.text === "string") {
                try {
                    hit = extractDisplayFromRunJson(JSON.parse(c.text));
                    if (hit)
                        return hit;
                }
                catch {
                    /* */
                }
            }
        }
    }
    // display-latest shape
    if (o.display && typeof o.display === "object") {
        const d = o.display;
        if (d.pixelBase64 || d.monoBase64)
            return d;
    }
    return undefined;
}
function extractSnapshotId(json) {
    if (!json || typeof json !== "object")
        return undefined;
    const o = json;
    if (typeof o.snapshot_id === "string" && o.snapshot_id)
        return o.snapshot_id;
    if (typeof o.snapshotId === "string" && o.snapshotId)
        return o.snapshotId;
    for (const nest of [o.result, o.run]) {
        const id = extractSnapshotId(nest);
        if (id)
            return id;
    }
    return undefined;
}
/** Find recent run/inspect JSON files under workspace .labwired */
function findRunJsonCandidates(workspaceRoot) {
    const roots = [
        path.join(workspaceRoot, ".labwired"),
        path.join(workspaceRoot, "evidence"),
        path.join(workspaceRoot, "artifacts"),
    ];
    const out = [];
    for (const root of roots) {
        walk(root, out, 0, 4);
    }
    out.sort((a, b) => {
        if (a.endsWith("display-latest.json"))
            return -1;
        if (b.endsWith("display-latest.json"))
            return 1;
        try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        }
        catch {
            return 0;
        }
    });
    return out.slice(0, 40);
}
function walk(dir, out, depth, maxDepth) {
    if (depth > maxDepth)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === "node_modules" || e.name === ".git")
                continue;
            walk(full, out, depth + 1, maxDepth);
        }
        else if (e.isFile() && /\.json$/i.test(e.name)) {
            if (/display|run|inspect|peripher|verify|result|snapshot/i.test(e.name) ||
                e.name === "display-latest.json") {
                out.push(full);
            }
        }
    }
}
/** Persist a display frame for Overview auto-load. */
function writeDisplayLatest(workspaceRoot, frame, extra) {
    const dir = path.join(workspaceRoot, ".labwired");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "display-latest.json");
    const payload = {
        ...extra,
        display: frame,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return file;
}
//# sourceMappingURL=fromPeripherals.js.map