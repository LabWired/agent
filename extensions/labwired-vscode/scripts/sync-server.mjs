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
const version = readFileSync(join(agentRoot, 'VERSION'), 'utf8').trim();
writeFileSync(join(outDir, 'AGENT_VERSION'), version + '\n');
console.log(`sync-server: bundled rpc-server.mjs (agent ${version})`);
