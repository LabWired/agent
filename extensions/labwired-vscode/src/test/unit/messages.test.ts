import * as assert from 'assert';
import {
  parseChatTextDelta, parseChatToolCall, parseChatToolResult,
  parseSerialConnectionState, parseSerialData, parsePlotUpdate,
  parseGdbState, onNotification, tryRpc,
} from '../../rpc/messages';

// Fixtures mirror notify() payloads in server/rpc-server.mjs exactly.
suite('rpc messages (server payload shapes)', () => {
  test('chat/textDelta uses {text}', () => {
    assert.strictEqual(parseChatTextDelta({ text: 'hello' }), 'hello');
    assert.strictEqual(parseChatTextDelta({}), '');
  });
  test('chat/toolCall uses {name,title,params}', () => {
    assert.deepStrictEqual(
      parseChatToolCall({ name: 'doctor', title: 'Doctor', params: { verbose: 1 } }),
      { name: 'doctor', title: 'Doctor', params: { verbose: 1 } });
  });
  test('chat/toolResult uses {name,code,detail}', () => {
    assert.deepStrictEqual(
      parseChatToolResult({ name: 'doctor', code: 0, detail: 'ok' }),
      { name: 'doctor', code: 0, detail: 'ok' });
  });
  test('serial/connectionState uses {open}', () => {
    assert.strictEqual(parseSerialConnectionState({ open: true, port: '/dev/cu.usb1' }), true);
    assert.strictEqual(parseSerialConnectionState({ open: false }), false);
  });
  test('serial/data uses {data,port}', () => {
    assert.strictEqual(parseSerialData({ data: 'temp=23.5\n', port: 'x' }), 'temp=23.5\n');
  });
  test('plot/update uses {series: Record<string, number[]>}', () => {
    assert.deepStrictEqual(parsePlotUpdate({ series: { temp: [1, 2] } }), { temp: [1, 2] });
    assert.deepStrictEqual(parsePlotUpdate({}), {});
  });
  test('debug/gdbState uses {running,chip,port}', () => {
    assert.deepStrictEqual(
      parseGdbState({ running: true, chip: 'esp32c3', port: 1337 }),
      { running: true, chip: 'esp32c3', port: 1337 });
  });
  test('onNotification routes only the named method', () => {
    const seen: string[] = [];
    const fake = { on(_ev: string, cb: (m: string, p: unknown) => void) {
      cb('plot/update', { series: {} }); cb('serial/data', { data: 'x' });
    } };
    onNotification(fake, 'serial/data', p => seen.push(parseSerialData(p)));
    assert.deepStrictEqual(seen, ['x']);
  });
  test('tryRpc resolves null on Method-not-found, rethrows transport errors', async () => {
    const methodNotFound = { request: () => Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 })) };
    assert.strictEqual(await tryRpc(methodNotFound as any, 'twin/run', {}), null);
    const appError = { request: () => Promise.reject(Object.assign(new Error('mode gate'), { code: -32000 })) };
    await assert.rejects(() => tryRpc(appError as any, 'tool/run', {}), /mode gate/);
  });
});
