// Pure parsers for labwired-agent RPC server notifications.
// Shapes pinned to server/rpc-server.mjs notify() call sites (protocol 0.5.0).
// NO vscode import — this module is unit-testable under plain node:test.

export interface NotificationSource {
  on(event: 'notification', cb: (method: string, params: unknown) => void): void;
}
export interface Requester {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** Subscribe to one server notification with a typed handler. */
export function onNotification(
  rpc: NotificationSource, method: string, handler: (params: any) => void,
): void {
  rpc.on('notification', (m, params) => { if (m === method) handler(params); });
}

/** Call an optional server method; resolve null when the server lacks it.
 *  NOTE: tryRpc is exempt from scripts/rpc-contract-check.mjs by design — it is
 *  the escape hatch for optional capabilities that tolerate server absence. */
export async function tryRpc(rpc: Requester, method: string, params: unknown): Promise<any | null> {
  try {
    return await rpc.request(method, params);
  } catch (err: any) {
    if (err && (err.code === -32601 || /method not found/i.test(String(err.message)))) return null;
    throw err;
  }
}

export function parseChatTextDelta(p: any): string { return typeof p?.text === 'string' ? p.text : ''; }

export interface ChatToolCall { name: string; title: string; params: unknown; }
export function parseChatToolCall(p: any): ChatToolCall {
  return { name: String(p?.name ?? ''), title: String(p?.title ?? p?.name ?? ''), params: p?.params ?? {} };
}

/** One chunk of a running tool's output. `stream` is 'stdout' | 'stderr'. */
export interface ChatToolDelta { name: string; stream: string; text: string; }
export function parseChatToolDelta(p: any): ChatToolDelta {
  return {
    name: String(p?.name ?? ''),
    stream: p?.stream === 'stderr' ? 'stderr' : 'stdout',
    text: typeof p?.text === 'string' ? p.text : '',
  };
}

/** `streamed` = the body already arrived via chat/toolDelta; do not re-render `detail`.
 *  Absent on in-process tools (__plot__/__hw__/__debug__), which return output whole. */
export interface ChatToolResult { name: string; code: number; detail: string; streamed: boolean; }
export function parseChatToolResult(p: any): ChatToolResult {
  return {
    name: String(p?.name ?? ''),
    code: Number(p?.code ?? -1),
    detail: String(p?.detail ?? ''),
    streamed: p?.streamed === true,
  };
}

export function parseSerialConnectionState(p: any): boolean { return p?.open === true; }
export function parseSerialData(p: any): string { return typeof p?.data === 'string' ? p.data : ''; }
export function parsePlotUpdate(p: any): Record<string, number[]> {
  return (p && typeof p.series === 'object' && p.series) ? p.series : {};
}

export interface GdbState { running: boolean; chip: string; port: number; }
export function parseGdbState(p: any): GdbState {
  return { running: p?.running === true, chip: String(p?.chip ?? ''), port: Number(p?.port ?? 0) };
}
