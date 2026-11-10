import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { Ledger, MemoryStore } from '../ledger/index';
import { AgentService, TokenStore, startBridge } from '../mcp/index';
import { connectionIsCurrent, runConnect } from './agentConnect';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-connect-preflight-'));
  const tokenFile = path.join(root, 'C-1.token');
  return { root, tokenFile };
}
async function current() {
  const f = fixture();
  const ledger = Ledger.openSync(new MemoryStore());
  const tokens = new TokenStore();
  const service = new AgentService({ ledger, tokens });
  const token = tokens.issue({ role: 'connect', person: 'owner' });
  fs.writeFileSync(f.tokenFile, token);
  const bridge = await startBridge(service);
  cleanup.push(() => bridge.close());
  return { ...f, ledger, tokens, service, token, bridge };
}
async function server(handler: Parameters<typeof createServer>[1]) {
  const s = createServer(handler);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
it('validates a live grant without hello, agent registration, claim or ledger writes; revoked grants fail', async () => {
  const f = await current();
  const before = f.ledger.entries().length;
  expect(await connectionIsCurrent(f.bridge.url, f.tokenFile)).toBe(true);
  expect(f.service.listAgents()).toEqual([]);
  expect(f.ledger.entries()).toHaveLength(before);
  f.tokens.revoke(f.token);
  expect(await connectionIsCurrent(f.bridge.url, f.tokenFile)).toBe(false);
  expect(f.service.listAgents()).toEqual([]);
  expect(f.ledger.entries()).toHaveLength(before);
});
it('refuses a stale grant before changing skill or MCP settings and does not print the token', async () => {
  const f = await current(); f.tokens.revoke(f.token);
  const output: string[] = [];
  const home = path.join(f.root, 'home');
  const code = await runConnect(['--agent', 'codex', f.bridge.url, f.tokenFile], { cwd: f.root, env: { PATH: '' }, home, here: f.root, out: s => output.push(s), err: s => output.push(s) });
  expect(code).not.toBe(0); expect(output.join('')).toMatch(/Connect agent again/);
  expect(output.join('')).not.toMatch(/Connected/); expect(output.join('')).not.toContain(f.token);
  expect(fs.existsSync(home)).toBe(false);
});
it('omitted provider refuses when only a stand-in Claude is present, without invoking it or writing configuration', async () => {
  const f = await current(); const marker = path.join(f.root, 'called');
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const cli = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  else fs.symlinkSync(cli, path.join(bin, 'claude'));
  const home = path.join(f.root, 'home'); const output: string[] = [];
  const code = await runConnect([f.bridge.url, f.tokenFile], { cwd: f.root, env: { PATH: bin, Path: bin }, home, here: f.root, out: s => output.push(s), err: s => output.push(s) });
  expect(code).not.toBe(0); expect(output.join('')).toMatch(/Codex.*not installed/);
  expect(fs.existsSync(marker)).toBe(false); expect(fs.existsSync(home)).toBe(false);
});
it('rejects a redirect without forwarding credentials and rejects oversized or malformed replies', async () => {
  const f = fixture(); fs.writeFileSync(f.tokenFile, 'private-test-token');
  let targetCalls = 0;
  const target = await server((_q, r) => { targetCalls++; r.end('{}'); });
  const redirect = await server((_q, r) => { r.writeHead(302, { location: target }); r.end(); });
  expect(await connectionIsCurrent(redirect, f.tokenFile)).toBe(false); expect(targetCalls).toBe(0);
  for (const body of ['x'.repeat(65537), '{broken', JSON.stringify({ ok: true, result: {} })]) {
    const url = await server((_q, r) => { r.end(body); });
    expect(await connectionIsCurrent(url, f.tokenFile)).toBe(false);
  }
});
it('bounds a stalled response body and refuses a closed bridge', async () => {
  const f = fixture(); fs.writeFileSync(f.tokenFile, 'private-test-token');
  const url = await server((_q, r) => { r.writeHead(200); r.write('{'); });
  const began = Date.now();
  expect(await connectionIsCurrent(url, f.tokenFile)).toBe(false);
  expect(Date.now() - began).toBeLessThan(5000);
  await cleanup.pop()!();
  expect(await connectionIsCurrent(url, f.tokenFile)).toBe(false);
});
