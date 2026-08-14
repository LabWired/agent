#!/usr/bin/env node
// Copy the agent RPC server into the extension so the VSIX is self-contained.
// rpcClient.start() prefers <extensionRoot>/server/rpc-server.mjs, so a packaged
// install no longer needs a system `labwired` on PATH.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = join(extRoot, '..', '..');
const outDir = join(extRoot, 'server');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(agentRoot, 'server', 'rpc-server.mjs'), join(outDir, 'rpc-server.mjs'));
// rpc-server.mjs does `import { resolveAgentLauncher } from "./agent-launcher.mjs"`,
// so the sibling module has to travel with it or the packaged server throws
// ERR_MODULE_NOT_FOUND before it can serve anything.
copyFileSync(join(agentRoot, 'server', 'agent-launcher.mjs'), join(outDir, 'agent-launcher.mjs'));

// share/tools.json is the server's tool table AND its mode policy. The server
// resolves it at <agentRoot>/share/tools.json, where agentRoot is the extension
// root in a packaged install, and it EXITS when the file is missing. Shipping
// the server without it produces a VSIX whose server dies on first spawn.
const shareDir = join(extRoot, 'share');
mkdirSync(shareDir, { recursive: true });
copyFileSync(join(agentRoot, 'share', 'tools.json'), join(shareDir, 'tools.json'));

const version = readFileSync(join(agentRoot, 'VERSION'), 'utf8').trim();
writeFileSync(join(outDir, 'AGENT_VERSION'), version + '\n');
console.log(`sync-server: bundled rpc-server.mjs + share/tools.json (agent ${version})`);
