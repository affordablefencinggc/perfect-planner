// Source identity only. Dependencies and executable identity require separate gates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptOnly = name => name === 'LEDGER.json' || name === 'LEDGER.md' || name.startsWith('.ledger/');
const excluded = ['.git','node_modules','dist','target','target-codex','.cache','.local-preview-cache','src-tauri/target','src-tauri/target-codex','src-tauri/gen/schemas'];
function noLinks(target) {
  for (let current = target;; current = path.dirname(current)) {
    assert(!fs.lstatSync(current).isSymbolicLink(), `Source path link: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
noLinks(root);
const head = git('rev-parse', 'HEAD');
assert.equal(git('diff', 'HEAD', '--name-only'), '', 'Commit all tracked changes before source qualification');
const entries = git('ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean).map(row => {
  const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
  assert(match, 'Only committed regular file blobs qualify');
  assert(['100644','100755'].includes(match[1]), 'Committed links do not qualify');
  return { object: match[2], name: match[3] };
}).filter(item => !receiptOnly(item.name));
const names = entries.map(item => item.name);
assert(names.includes('scripts/verify-dans1-source.mjs'), 'Verifier must be committed');
assert(names.length > 0);
assert(!names.some(name => excluded.some(ex => name === ex || name.startsWith(ex + '/'))), 'Tracked source must not be excluded');
const blobs = execFileSync('git', ['cat-file','--batch'], { cwd: root, input: entries.map(item => item.object).join('\n')+'\n', maxBuffer: 128 * 1024 * 1024 });
let offset = 0;
const files = entries.map(({ name, object }) => {
  const end = blobs.indexOf(10, offset);
  const header = blobs.subarray(offset,end).toString('ascii').split(' ');
  assert.equal(header[0],object); assert.equal(header[1],'blob');
  const size = Number(header[2]); assert(Number.isSafeInteger(size) && size >= 0);
  const committed = blobs.subarray(end+1,end+1+size); offset=end+size+2;
  const target = path.join(root, name);
  noLinks(target);
  assert(fs.lstatSync(target).isFile(), `Local source link or non-file: ${name}`);
  const bytes = fs.readFileSync(target);
  // Explicit checkout policy: exact blob bytes, or CRLF expansion of an LF text
  // blob. No arbitrary clean/smudge filter is trusted to justify different data.
  const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'),'utf8');
  const losslessText = Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes);
  assert(bytes.equals(committed) || (losslessText && !committed.includes(0) && !bytes.includes(0) && normalized.equals(committed)), `Working source differs from committed blob: ${name}`);
  return { path: name, object, sha256: sha(bytes) };
});
assert.equal(offset,blobs.length,'Complete Git blob stream required');
const expected = { head, files };
// Stream the exact local checker and inventory over authenticated SSH. No mutable
// remote checker or remote manifest can substitute its own expected file list.
const remote = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const expected=${JSON.stringify(expected)};
assert.equal(os.hostname().toLowerCase(),'dans1');
const root='C:/Users/danie/Documents/perfect-planner-tests/roadmap-20260926-01/app-finish70';
const excluded=new Set(${JSON.stringify(excluded)});
for(let current=root;;current=path.dirname(current)){
 assert(!fs.lstatSync(current).isSymbolicLink(),'Source root or ancestor link: '+current);
 if(path.dirname(current)===current)break;
}
const actual=[];
function walk(dir,relative=''){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const name=relative?relative+'/'+entry.name:entry.name;
  if(excluded.has(name)||name==='LEDGER.json'||name==='LEDGER.md'||name==='.ledger')continue;
  const full=path.join(dir,entry.name), stat=fs.lstatSync(full);
  assert(!stat.isSymbolicLink(),'Source link: '+name);
  if(stat.isDirectory())walk(full,name);
  else {assert(stat.isFile(),'Non-file: '+name);actual.push(name);}
 }
}
walk(root);
assert.deepEqual(actual.sort(),expected.files.map(item=>item.path).sort(),'Exact source inventory differs');
for(const item of expected.files){
 const actual=createHash('sha256').update(fs.readFileSync(path.join(root,item.path))).digest('hex');
 assert.equal(actual,item.sha256,'Source bytes differ: '+item.path);
}
console.log(JSON.stringify({host:os.hostname(),head:expected.head,files:expected.files.length,scope:'source-only snapshot, not build custody or dependency identity',excluded:[...excluded],manifestSha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex')}));
`;
const result = spawnSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','tonys-test-pc','C:/Users/danie/Documents/perfect-planner-tests/pp-20260905-remote-01/tools/node-v22.23.2-win-x64/node.exe','--input-type=module','-'], { input: remote, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'DANS1 source qualification failed');
assert.equal(git('rev-parse','HEAD'),head,'Local revision changed during comparison');
assert.equal(git('diff','HEAD','--name-only'),'','Local source changed during comparison');
console.log(JSON.stringify({checkerSha256:sha(Buffer.from(remote)),head,scope:'source-only'}));
