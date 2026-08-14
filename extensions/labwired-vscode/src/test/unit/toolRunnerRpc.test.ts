import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRunner } from '../../tools/runner';

function fakeRpc(tools: string[], runResult?: any) {
  const calls: { name: string; params: unknown }[] = [];
  const methods: string[] = [];
  const handlers: Record<string, (() => void)[]> = {};
  return {
    calls,
    methods,
    isRunning: () => true,
    on(ev: string, cb: () => void) { (handlers[ev] ||= []).push(cb); },
    emitLocal(ev: string) { for (const cb of handlers[ev] || []) cb(); },
    request: async (method: string, params: any) => {
      methods.push(method);
      if (method === 'tool/list') return { tools: tools.map((name) => ({ name })) };
      if (method === 'tool/run') {
        calls.push({ name: params.name, params: params.params });
        return runResult ?? { name: params.name, code: 0, stdout: 'ok', stderr: '', timedOut: false };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

function fakeBridge(run: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return { ensureCli: async () => {}, run };
}

// ToolRunner(bridge, catalog, datasheets, debug, billing, rpc)
test('routes a server-known tool through tool/run', async () => {
    const rpc = fakeRpc(['doctor']);
    const bridge = fakeBridge(async () => { throw new Error('CLI must not be used'); });
    const runner = new ToolRunner(bridge as any, undefined, undefined, undefined, undefined, rpc as any);
    const res = await runner.runNamed('doctor', {});
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.status, 'ok');
    assert.deepStrictEqual(rpc.calls, [{ name: 'doctor', params: {} }]);
});

test('falls back to CLI for server-unknown tool', async () => {
    const rpc = fakeRpc(['doctor']);
    let cliArgv: string[] = [];
    const bridge = fakeBridge(async (argv: string[]) => { cliArgv = argv; return { code: 0, stdout: 'cli', stderr: '' }; });
    const runner = new ToolRunner(bridge as any, undefined, undefined, undefined, undefined, rpc as any);
    await runner.runNamed('update', {});
    assert.deepStrictEqual(cliArgv, ['update']);
});

test('falls back to CLI when server is down', async () => {
    const rpc = { ...fakeRpc(['doctor']), isRunning: () => false };
    let used = false;
    const bridge = fakeBridge(async () => { used = true; return { code: 0, stdout: 'cli', stderr: '' }; });
    const runner = new ToolRunner(bridge as any, undefined, undefined, undefined, undefined, rpc as any);
    await runner.runNamed('doctor', {});
    assert.strictEqual(used, true);
});

test('mode-gate error surfaces as message, not crash', async () => {
    const rpc = fakeRpc(['probe_flash']);
    rpc.request = async (m: string) => {
      if (m === 'tool/list') return { tools: [{ name: 'probe_flash' }] };
      throw Object.assign(new Error('plan mode: destructive tool denied'), { code: -32000 });
    };
    const bridge = fakeBridge(async () => { throw new Error('no CLI'); });
    const runner = new ToolRunner(bridge as any, undefined, undefined, undefined, undefined, rpc as any);
    const res = await runner.runNamed('probe_flash', { elf: 'a.elf', chip: 'STM32L476RGTx' });
    assert.strictEqual(res.code, -32000);
    assert.strictEqual(res.status, 'error');
    assert.match(res.output, /plan mode/);
});

test('extension-local pseudo-tools stay ahead of RPC (debug_info)', async () => {
    const rpc = fakeRpc(['debug_info', 'doctor']);
    let cliUsed = false;
    const bridge = fakeBridge(async () => { cliUsed = true; return { code: 0, stdout: 'cli', stderr: '' }; });
    const debug = { info: () => 'local debug info' };
    const runner = new ToolRunner(bridge as any, undefined, undefined, debug as any, undefined, rpc as any);
    const res = await runner.runNamed('debug_info', {});
    assert.strictEqual(res.code, 0);
    assert.match(res.output, /local debug info/);
    assert.deepStrictEqual(rpc.methods, []);
    assert.strictEqual(cliUsed, false);
});

test('invalidates cached tool/list on rpc exit/ready', async () => {
    const rpc = fakeRpc(['doctor']);
    const bridge = fakeBridge(async () => { throw new Error('CLI must not be used'); });
    const runner = new ToolRunner(bridge as any, undefined, undefined, undefined, undefined, rpc as any);
    const listCalls = () => rpc.methods.filter((m) => m === 'tool/list').length;
    await runner.runNamed('doctor', {});
    await runner.runNamed('doctor', {});
    assert.strictEqual(listCalls(), 1);
    rpc.emitLocal('exit');
    await runner.runNamed('doctor', {});
    assert.strictEqual(listCalls(), 2);
    rpc.emitLocal('ready');
    await runner.runNamed('doctor', {});
    assert.strictEqual(listCalls(), 3);
});
