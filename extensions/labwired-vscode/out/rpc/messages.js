"use strict";
// Pure parsers for labwired-agent RPC server notifications.
// Shapes pinned to server/rpc-server.mjs notify() call sites (protocol 0.5.0).
// NO vscode import — this module is unit-testable under plain mocha.
Object.defineProperty(exports, "__esModule", { value: true });
exports.onNotification = onNotification;
exports.tryRpc = tryRpc;
exports.parseChatTextDelta = parseChatTextDelta;
exports.parseChatToolCall = parseChatToolCall;
exports.parseChatToolResult = parseChatToolResult;
exports.parseSerialConnectionState = parseSerialConnectionState;
exports.parseSerialData = parseSerialData;
exports.parsePlotUpdate = parsePlotUpdate;
exports.parseGdbState = parseGdbState;
/** Subscribe to one server notification with a typed handler. */
function onNotification(rpc, method, handler) {
    rpc.on('notification', (m, params) => { if (m === method)
        handler(params); });
}
/** Call an optional server method; resolve null when the server lacks it.
 *  NOTE: tryRpc is exempt from scripts/rpc-contract-check.mjs by design — it is
 *  the escape hatch for optional capabilities that tolerate server absence. */
async function tryRpc(rpc, method, params) {
    try {
        return await rpc.request(method, params);
    }
    catch (err) {
        if (err && (err.code === -32601 || /method not found/i.test(String(err.message))))
            return null;
        throw err;
    }
}
function parseChatTextDelta(p) { return typeof p?.text === 'string' ? p.text : ''; }
function parseChatToolCall(p) {
    return { name: String(p?.name ?? ''), title: String(p?.title ?? p?.name ?? ''), params: p?.params ?? {} };
}
function parseChatToolResult(p) {
    return { name: String(p?.name ?? ''), code: Number(p?.code ?? -1), detail: String(p?.detail ?? '') };
}
function parseSerialConnectionState(p) { return p?.open === true; }
function parseSerialData(p) { return typeof p?.data === 'string' ? p.data : ''; }
function parsePlotUpdate(p) {
    return (p && typeof p.series === 'object' && p.series) ? p.series : {};
}
function parseGdbState(p) {
    return { running: p?.running === true, chip: String(p?.chip ?? ''), port: Number(p?.port ?? 0) };
}
//# sourceMappingURL=messages.js.map