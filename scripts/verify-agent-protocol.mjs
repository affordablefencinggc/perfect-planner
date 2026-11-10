import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Qualify the exact shipped artifact, not a separately imported tool definition.
const agent = path.resolve(process.argv[2] ?? 'dist/core-host/agent.mjs');
const runtime = process.argv[3] ?? process.execPath;
const hash = createHash('sha256').update(readFileSync(agent)).digest('hex');
const token = randomUUID();
const calls = [];
const bridge = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/call' || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403); res.end(); return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push(body);
  res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ ok: true, result: body.tool === 'hello' ? { agent: 'protocol-fixture-worker' } : { recorded: true } }));
});
await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
const fixture = mkdtempSync(path.join(os.tmpdir(), 'pp-agent-protocol-'));
const transport = new StdioClientTransport({ command: runtime, args: [agent], cwd: fixture, stderr: 'pipe', env: {
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  PP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`, PP_AGENT_TOKEN: token,
} });
const client = new Client({ name: 'artifact-protocol-check', version: '1' });
try {
  await client.connect(transport);
  const list = await client.listTools();
  const progress = list.tools.find(tool => tool.name === 'report_progress');
  assert.deepEqual(progress?.inputSchema?.properties?.activity?.enum, ['working', 'waiting', 'finished']);
  assert.ok(!progress.inputSchema.required.includes('activity'));
  const hello = await client.callTool({ name: 'hello', arguments: { name: 'Protocol fixture', model: 'gpt-5.6' } });
  assert.ok(!hello.isError);
  assert.equal(calls.at(-1).args.model, 'gpt-5.6');
  for (const activity of ['working', 'waiting', 'finished', undefined]) {
    const args = { task: 'T-1', text: 'Protocol fixture', ...(activity ? { activity } : {}) };
    const response = await client.callTool({ name: 'report_progress', arguments: args });
    assert.ok(!response.isError);
    assert.deepEqual(calls.at(-1), { tool: 'report_progress', args, agent: 'protocol-fixture-worker' });
  }
  const before = calls.length;
  let invalidRejected = false;
  try { invalidRejected = (await client.callTool({ name: 'report_progress', arguments: { task: 'T-1', text: 'Invalid fixture', activity: 'pretend' } })).isError === true; }
  catch { invalidRejected = true; }
  assert.equal(invalidRejected, true);
  assert.equal(calls.length, before, 'invalid activity must not reach the bridge');
  console.log(JSON.stringify({ passed: true, agent, sha256: hash, runtime, activity: ['working', 'waiting', 'finished'], omittedActivity: true, invalidRejected: true, helloModelForwarded: true }));
} finally {
  await client.close();
  await transport.close();
  bridge.closeAllConnections();
  await new Promise(resolve => bridge.close(resolve));
}
