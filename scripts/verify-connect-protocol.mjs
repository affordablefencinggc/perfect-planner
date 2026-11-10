import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// Runs the actual bundle against its actual bridge, with throwaway memory keys
// and a stand-in Codex executable. Never invokes a real provider CLI.
// node verify-connect-protocol.mjs <bundle/connect.mjs> <qualified node runtime>
const connect = path.resolve(process.argv[2]);
const runtime = path.resolve(process.argv[3] ?? process.execPath);
const index = path.join(path.dirname(connect), 'index.mjs');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const { createCoreHost, hostKeys } = await import(pathToFileURL(index).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-connect-protocol-'));
const projectRoot = path.join(root, 'project');
const bin = path.join(root, 'stand-in-bin');
const cwd = path.join(root, 'work');
const home = path.join(root, 'home');
for (const dir of [projectRoot, bin, cwd, home]) fs.mkdirSync(dir);
const marker = path.join(root, 'codex-invocations.jsonl');
const cli = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
fs.mkdirSync(path.dirname(cli), { recursive: true });
fs.writeFileSync(cli, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`);
if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n');
else { fs.chmodSync(cli, 0o755); fs.symlinkSync(cli, path.join(bin, 'codex')); }
const host = createCoreHost({ root: path.join(root, 'state'), projectRootOverride: projectRoot, keys: hostKeys({ PP_CORE_KEYS: 'memory' }), bridge: true, watch: false });
const project = await host.openProject('connect-smoke');
const bridge = await host.bridge(project);
const token = project.service.tokens.issue({ role: 'connect', person: 'smoke-owner' });
const tokenFile = path.join(projectRoot, '.perfect-planner', 'tokens', 'C-1.token');
fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, token);
const env = {
  PATH: bin, Path: bin, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  TEMP: root, TMP: root, TMPDIR: root,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot } : {}),
};
const execute = () => new Promise((resolve, reject) => {
  const child = spawn(runtime, [connect, bridge.url, tokenFile], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Connect smoke exceeded 30 seconds')); }, 30000);
  const capture = chunk => { output += chunk.toString(); if (output.length > 32768) { child.kill(); reject(Error('Connect smoke output exceeded limit')); } };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
});
const tree = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const file = path.join(dir, e.name); return e.isDirectory() ? tree(file) : [{ file: path.relative(home, file), hash: hash(file) }];
}).sort((a, b) => a.file.localeCompare(b.file));
try {
  const count = project.entries().length;
  const valid = await execute();
  assert.equal(valid.code, 0); assert.equal(valid.signal, null); assert.match(valid.output, /Connected Codex CLI/);
  assert.ok(!valid.output.includes(token));
  const calls = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], ['mcp', 'remove', 'perfect-planner-core']);
  assert.deepEqual(calls[1].slice(0, 3), ['mcp', 'add', 'perfect-planner-core']);
  assert.ok(!fs.readFileSync(marker, 'utf8').includes(token));
  assert.deepEqual(project.service.listAgents(), []); assert.equal(project.entries().length, count);
  const beforeHome = tree(home); const beforeMarker = hash(marker);
  project.service.tokens.revoke(token);
  const stale = await execute();
  assert.notEqual(stale.code, 0); assert.equal(stale.signal, null);
  assert.match(stale.output, /Connect agent again/); assert.doesNotMatch(stale.output, /Connected/);
  assert.ok(!stale.output.includes(token));
  assert.equal(hash(marker), beforeMarker); assert.deepEqual(tree(home), beforeHome);
  assert.deepEqual(project.service.listAgents(), []); assert.equal(project.entries().length, count);
  console.log(JSON.stringify({ passed: true, connectHash: hash(connect), indexHash: hash(index), runtimeHash: hash(runtime), assertions: ['actual-bundled-connect', 'actual-bundled-bridge', 'memory-keys-only', 'implicit-codex', 'valid-registration', 'revoked-before-settings-write', 'no-agent-claim-or-ledger-write', 'no-token-output'] }));
} finally { await host.close(); }
