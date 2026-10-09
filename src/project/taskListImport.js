// Pure parser for a pasted task list (Markdown or CSV/TSV with a header row).
// It only reads text into plain entries plus per-line problems. It never
// validates claims or saves anything: the Ledger runs each entry through the
// same form parser, validator and durable Save path as the manual editor.

export const TASK_LIST_PASTE_CHARS = 200_000;

const FIELD_ALIASES = {
  title: 'title', task: 'title', 'task title': 'title',
  description: 'description', desc: 'description', details: 'description',
  owner: 'owner', 'proposed owner': 'owner',
  write: 'write', writes: 'write', 'write claims': 'write', 'write files': 'write',
  read: 'read', reads: 'read', 'read claims': 'read', 'read files': 'read',
  'done when': 'acceptance', acceptance: 'acceptance', 'acceptance criteria': 'acceptance',
  recovery: 'recovery', 'recovery plan': 'recovery',
  'depends on': 'dependsOn', depends: 'dependsOn', dependencies: 'dependsOn',
};
const TEXT_FIELDS = new Set(['description', 'acceptance', 'recovery']);
const LIST_FIELDS = new Set(['write', 'read', 'dependsOn']);
const normalizeKey = value => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const fieldFor = key => FIELD_ALIASES[normalizeKey(key)] ?? null;
const splitPaths = value => value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean);
const splitIds = value => value.split(/[\s,;]+/).map(part => part.trim()).filter(Boolean);
const LABEL = {title: 'title', description: 'description', owner: 'owner', write: 'write', read: 'read', acceptance: 'done when', recovery: 'recovery', dependsOn: 'depends on'};

const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const entry = (line, title) => ({line, title, description: '', owner: '', acceptance: '', recovery: '', write: [], read: [], dependsOn: []});

function setField(task, field, value, line, text, errors) {
  if (LIST_FIELDS.has(field)) { task[field].push(...(field === 'dependsOn' ? splitIds(value) : splitPaths(value))); return; }
  if (TEXT_FIELDS.has(field)) { task[field] = task[field] ? `${task[field]}\n${value}` : value; return; }
  if (task[field]) { errors.push({line, text, reason: `The ${LABEL[field]} was already set for "${task.title}" on an earlier line; this line was not used.`}); return; }
  task[field] = value;
}

function parseMarkdown(lines) {
  const tasks = [], errors = [], notes = [];
  let current = null, currentIsHeading = false, currentHasContent = false, inFence = false;
  const finish = nextIsBullet => {
    // A bare heading directly above bullet tasks is a section title ("# Sprint
    // plan"), not a task of its own. Say so instead of silently dropping it.
    if (current && currentIsHeading && !currentHasContent && nextIsBullet) {
      tasks.pop();
      notes.push({line: current.line, text: current.title, reason: 'Used as a section heading, not a task, because bullet tasks follow it.'});
    }
  };
  lines.forEach((raw, index) => {
    const line = index + 1, text = raw.trim();
    if (/^(```|~~~)/.test(text)) { inFence = !inFence; return; }
    if (inFence || !text || /^([-*_])(\s*\1){2,}$/.test(text)) return;
    const indented = /^\s/.test(raw);
    const heading = text.match(/^#{1,6}(?:\s+(.*?))?\s*#*$/);
    const bullet = text.match(/^(?:[-*+]|\d{1,4}[.)])(?:\s+(.*))?$/);
    const body = bullet ? (bullet[1] ?? '').replace(/^\[[ xX]\]\s*/, '').trim() : text;
    const keyed = body.match(/^([A-Za-z][A-Za-z _-]{0,30}?)\s*:\s*(.*)$/);
    const field = keyed ? fieldFor(keyed[1]) : null;
    if (heading && !heading[1]?.trim()) { errors.push({line, text, reason: 'This heading has no title, so no task was made from it.'}); return; }
    if (field && field !== 'title' && !(heading)) {
      if (!current) { errors.push({line, text, reason: 'This field comes before the first task. Start a task with "- " or "## " above it.'}); return; }
      currentHasContent = true;
      const value = keyed[2].trim();
      if (!value) { errors.push({line, text, reason: `The ${LABEL[field]} line is empty; nothing was recorded.`}); return; }
      setField(current, field, value, line, text, errors);
      return;
    }
    if (heading || (bullet && !indented)) {
      const title = heading ? heading[1].trim() : body;
      if (!title) { errors.push({line, text, reason: 'This list item has no title, so no task was made from it.'}); return; }
      finish(Boolean(bullet));
      current = entry(line, title); currentIsHeading = Boolean(heading); currentHasContent = false;
      tasks.push(current);
      return;
    }
    if (!current) { errors.push({line, text, reason: 'This text comes before the first task. Start each task with "- ", "1." or a "## " heading.'}); return; }
    if (bullet && !body) { errors.push({line, text, reason: 'This list item has no text; it was not used.'}); return; }
    currentHasContent = true;
    current.description = current.description ? `${current.description}\n${body}` : body;
  });
  return {tasks, errors, notes};
}

// RFC 4180-style reader shared by CSV and TSV: quoted cells may contain the
// delimiter, doubled quotes and line breaks.
function readDelimited(source, delimiter) {
  const rows = [];
  let i = 0, line = 1;
  while (i < source.length) {
    const startLine = line, cells = [];
    let cell = '', error = null;
    for (;;) {
      if (source[i] === '"' && cell === '') {
        i++;
        let closed = false;
        while (i < source.length) {
          if (source[i] === '"') { if (source[i + 1] === '"') { cell += '"'; i += 2; continue; } i++; closed = true; break; }
          if (source[i] === '\n') line++;
          cell += source[i++];
        }
        if (!closed) { error = 'A quoted cell is missing its closing quote ("), so this row and everything after it could not be read.'; break; }
        while (i < source.length && source[i] !== delimiter && source[i] !== '\n') cell += source[i++];
      } else {
        while (i < source.length && source[i] !== delimiter && source[i] !== '\n') cell += source[i++];
      }
      cells.push(cell); cell = '';
      if (i >= source.length) break;
      if (source[i] === delimiter) { i++; continue; }
      i++; line++; break; // newline ends the row
    }
    rows.push({line: startLine, cells, error});
    if (error) break;
  }
  return rows;
}

function parseTable(source, delimiter) {
  const tasks = [], errors = [], notes = [];
  const lines = source.split('\n');
  const rows = readDelimited(source, delimiter).filter(row => row.error || row.cells.some(cell => cell.trim()));
  const textOf = row => (lines[row.line - 1] ?? '').trim();
  const [header, ...body] = rows;
  if (!header) return {tasks, errors, notes, ignoredColumns: []};
  if (header.error) return {tasks, errors: [{line: header.line, text: textOf(header), reason: header.error}], notes, ignoredColumns: []};
  const columns = header.cells.map(cell => fieldFor(cell));
  const ignoredColumns = [];
  const seen = new Set();
  columns.forEach((field, index) => {
    if (!field || seen.has(field)) { columns[index] = null; if (header.cells[index].trim()) ignoredColumns.push(header.cells[index].trim()); }
    else seen.add(field);
  });
  if (!seen.has('title')) {
    errors.push({line: header.line, text: textOf(header), reason: 'The first row must be a header that includes a "title" column (for example: title, description, write, read, done_when, owner).'});
    return {tasks, errors, notes, ignoredColumns};
  }
  for (const row of body) {
    if (row.error) { errors.push({line: row.line, text: textOf(row), reason: row.error}); continue; }
    const values = {};
    columns.forEach((field, index) => { if (field) values[field] = (row.cells[index] ?? '').trim(); });
    if (!values.title) { errors.push({line: row.line, text: textOf(row), reason: 'This row has no title, so no task was made from it.'}); continue; }
    const task = entry(row.line, values.title);
    for (const [field, value] of Object.entries(values)) if (field !== 'title' && value) setField(task, field, value, row.line, textOf(row), errors);
    tasks.push(task);
  }
  return {tasks, errors, notes, ignoredColumns};
}

/**
 * Read a pasted task list. Returns a frozen
 * {format, tasks:[{line,title,description,owner,acceptance,recovery,write,read,dependsOn}],
 *  errors:[{line,text,reason}], notes:[{line,text,reason}], ignoredColumns:[]}.
 * Line numbers are 1-based positions in the pasted text.
 */
export function parseTaskList(input) {
  if (typeof input !== 'string') throw new TypeError('Paste the task list as text.');
  const source = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (source.length > TASK_LIST_PASTE_CHARS) {
    return frozen({format: 'unknown', tasks: [], errors: [{line: 1, text: '', reason: `The pasted list is too long (over ${TASK_LIST_PASTE_CHARS.toLocaleString('en-US')} characters). Paste it in smaller parts.`}], notes: [], ignoredColumns: []});
  }
  const lines = source.split('\n');
  const first = lines.find(line => line.trim())?.trim();
  if (!first) return frozen({format: 'unknown', tasks: [], errors: [{line: 1, text: '', reason: 'Paste a task list first: one task per "- " line, or a CSV/TSV table with a header row.'}], notes: [], ignoredColumns: []});
  const looksMarkdown = /^(#|[-*+]\s|[-*+]$|\d{1,4}[.)](\s|$))/.test(first);
  if (!looksMarkdown && first.includes('\t')) return frozen({format: 'tsv', ...parseTable(source, '\t')});
  if (!looksMarkdown && first.includes(',')) return frozen({format: 'csv', ...parseTable(source, ',')});
  return frozen({format: 'markdown', ...parseMarkdown(lines), ignoredColumns: []});
}

// The exact text shape the manual "Add a task" editor holds, so pasted tasks
// go through the same form parsing, validation and durable Save as typed ones.
export function taskListEntryToForm(task) {
  return {
    id: null,
    title: task.title,
    description: task.description,
    owner: task.owner,
    acceptance: task.acceptance,
    recovery: task.recovery,
    claims: [...task.write.map(path => `write ${path}`), ...task.read.map(path => `read ${path}`)].join('\n'),
    dependsOn: task.dependsOn.join(', '),
    archived: false,
  };
}
