import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskList, taskListEntryToForm, TASK_LIST_PASTE_CHARS } from '../src/project/taskListImport.js';

const titles = result => result.tasks.map(task => task.title);

test('markdown bullets with key: value lines become tasks with fields', () => {
  const result = parseTaskList([
    '- Add login page',
    '  owner: Sam',
    '  write: src/login.jsx, src/login.css',
    '  read: src/api.js',
    '  done when: A user can sign in',
    '  description: Email and password form',
    '- Fix crash on start',
    '  Owner: Ana',
  ].join('\n'));
  assert.equal(result.format, 'markdown');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(titles(result), ['Add login page', 'Fix crash on start']);
  const [first, second] = result.tasks;
  assert.equal(first.line, 1);
  assert.equal(first.owner, 'Sam');
  assert.deepEqual(first.write, ['src/login.jsx', 'src/login.css']);
  assert.deepEqual(first.read, ['src/api.js']);
  assert.equal(first.acceptance, 'A user can sign in');
  assert.equal(first.description, 'Email and password form');
  assert.equal(second.line, 7);
  assert.equal(second.owner, 'Ana');
  assert.deepEqual(second.write, []);
});

test('markdown numbered lists, other bullet markers and checkboxes', () => {
  const result = parseTaskList('1. First task\n2) Second task\n* Third task\n+ Fourth task\n- [ ] Fifth task\n- [x] Sixth task');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(titles(result), ['First task', 'Second task', 'Third task', 'Fourth task', 'Fifth task', 'Sixth task']);
});

test('markdown heading blocks with bulleted fields and paragraph descriptions', () => {
  const result = parseTaskList([
    '## Build the settings page',
    'Let people change their theme.',
    'Keep it simple.',
    '- owner: Lee',
    '- write: src/settings.jsx',
    '- done-when: Theme persists after reload',
    '',
    '### Write docs',
    'done_when: README explains setup',
  ].join('\n'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(titles(result), ['Build the settings page', 'Write docs']);
  assert.equal(result.tasks[0].description, 'Let people change their theme.\nKeep it simple.');
  assert.equal(result.tasks[0].owner, 'Lee');
  assert.deepEqual(result.tasks[0].write, ['src/settings.jsx']);
  assert.equal(result.tasks[0].acceptance, 'Theme persists after reload');
  assert.equal(result.tasks[1].acceptance, 'README explains setup');
});

test('a single top-level heading followed by bullet tasks is a list title, not a task', () => {
  const result = parseTaskList('# Sprint plan\n- One\n- Two');
  assert.deepEqual(titles(result), ['One', 'Two']);
  assert.deepEqual(result.errors, []);
});

test('top-level bullet titles may contain colons; repeated claims accumulate', () => {
  const result = parseTaskList('- Fix bug: crash on load\n  write: src/a.js\n  write: src/b.js; src/c.js\n  reads: docs/x.md');
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].title, 'Fix bug: crash on load');
  assert.deepEqual(result.tasks[0].write, ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.deepEqual(result.tasks[0].read, ['docs/x.md']);
});

test('markdown reports unreadable lines with line numbers and reasons', () => {
  const result = parseTaskList([
    'Some intro text',
    'owner: Nobody',
    '- ',
    '- Real task',
    '  owner: A',
    '  owner: B',
    '##',
  ].join('\n'));
  assert.deepEqual(titles(result), ['Real task']);
  assert.equal(result.tasks[0].owner, 'A');
  const byLine = Object.fromEntries(result.errors.map(error => [error.line, error]));
  assert.deepEqual(Object.keys(byLine).map(Number), [1, 2, 3, 6, 7]);
  assert.match(byLine[1].reason, /before the first task/i);
  assert.match(byLine[2].reason, /before the first task/i);
  assert.match(byLine[3].reason, /no title/i);
  assert.match(byLine[6].reason, /owner.*already/i);
  assert.match(byLine[7].reason, /no title/i);
  assert.equal(byLine[1].text, 'Some intro text');
});

test('unknown key lines under a task are kept as description text, never dropped', () => {
  const result = parseTaskList('- Task\n  note: remember the cache\n  description: Main point');
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].description, 'note: remember the cache\nMain point');
});

test('code fences, blank lines and horizontal rules are skipped', () => {
  const result = parseTaskList('\n\n- One\n\n---\n\n- Two\n');
  assert.deepEqual(titles(result), ['One', 'Two']);
  assert.deepEqual(result.errors, []);
});

test('CSV with a header row, case-insensitive columns, extra columns ignored', () => {
  const result = parseTaskList([
    'Title,Description,Write,Read,Done_When,Owner,Priority',
    'Add login,"Email, password form",src/login.jsx;src/login.css,src/api.js,User can sign in,Sam,high',
    '"Fix ""crash""",,src/main.js,,,Ana,low',
  ].join('\n'));
  assert.equal(result.format, 'csv');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ignoredColumns, ['Priority']);
  assert.deepEqual(titles(result), ['Add login', 'Fix "crash"']);
  const [first, second] = result.tasks;
  assert.equal(first.line, 2);
  assert.equal(first.description, 'Email, password form');
  assert.deepEqual(first.write, ['src/login.jsx', 'src/login.css']);
  assert.deepEqual(first.read, ['src/api.js']);
  assert.equal(first.acceptance, 'User can sign in');
  assert.equal(first.owner, 'Sam');
  assert.equal(second.line, 3);
  assert.deepEqual(second.write, ['src/main.js']);
});

test('CSV quoted cells may span lines; line numbers point at the row start', () => {
  const result = parseTaskList('title,description\nFirst,"line one\nline two"\nSecond,plain');
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].description, 'line one\nline two');
  assert.equal(result.tasks[1].line, 4);
});

test('TSV (spreadsheet paste) with header row and header aliases', () => {
  const result = parseTaskList('TITLE\tOwner\tDone when\twrite\nShip it\tKim\tIt is live\tsrc/a.js, src/b.js\n\nSecond\t\t\t');
  assert.equal(result.format, 'tsv');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(titles(result), ['Ship it', 'Second']);
  assert.equal(result.tasks[0].acceptance, 'It is live');
  assert.deepEqual(result.tasks[0].write, ['src/a.js', 'src/b.js']);
  assert.equal(result.tasks[1].line, 4);
});

test('table rows without a title, and unterminated quotes, are reported', () => {
  const result = parseTaskList('title,owner\n,Sam\nGood,Ana\n"Broken,Kim');
  assert.deepEqual(titles(result), ['Good']);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].line, 2);
  assert.match(result.errors[0].reason, /no title/i);
  assert.equal(result.errors[1].line, 4);
  assert.match(result.errors[1].reason, /quote/i);
});

test('a table header without a title column is explained', () => {
  const result = parseTaskList('name,owner\nThing,Sam');
  assert.deepEqual(result.tasks, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 1);
  assert.match(result.errors[0].reason, /"title" column/i);
});

test('empty and oversize input', () => {
  const empty = parseTaskList('   \n  ');
  assert.deepEqual(empty.tasks, []);
  assert.match(empty.errors[0].reason, /paste/i);
  const big = parseTaskList('- x\n'.repeat(Math.ceil((TASK_LIST_PASTE_CHARS + 10) / 4)));
  assert.deepEqual(big.tasks, []);
  assert.match(big.errors[0].reason, /too long/i);
  assert.throws(() => parseTaskList(null), /text/);
});

test('Windows line endings and a byte-order mark are handled', () => {
  const result = parseTaskList('﻿- One\r\n  owner: A\r\n- Two\r\n');
  assert.deepEqual(titles(result), ['One', 'Two']);
  assert.equal(result.tasks[0].owner, 'A');
});

test('parser output is plain data and does not validate claims itself', () => {
  const result = parseTaskList('- Glob task\n  write: src/core/**');
  assert.deepEqual(result.tasks[0].write, ['src/core/**']);
  assert.equal(Object.isFrozen(result), true);
});

test('taskListEntryToForm produces the manual editor form shape', () => {
  const [entry] = parseTaskList('- Add login\n  owner: Sam\n  write: src/a.js\n  read: src/b.js\n  done when: Works\n  recovery: Revert\n  depends on: T0001, T0002').tasks;
  assert.deepEqual(taskListEntryToForm(entry), {
    id: null, title: 'Add login', description: '', owner: 'Sam', acceptance: 'Works', recovery: 'Revert',
    claims: 'write src/a.js\nread src/b.js', dependsOn: 'T0001, T0002', archived: false,
  });
});
