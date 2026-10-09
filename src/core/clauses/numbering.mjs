// Clause numbering for Perfect Planner plan versions.
// Pure functions only: no file system, no clock, no network.
//
// Clause ids look like "§1", "§3.1", "§3.1.1". Top-level headings are §1, §2, ...
// Children of a clause are numbered 1, 2, ... under it. Published ids never move:
// when a previous numbered version is supplied, matched clauses keep their ids,
// inserted clauses become sub-clauses of the preceding published clause, and
// removed clauses stay in the list with status "withdrawn".

export const CLAUSE_ID_PATTERN = /^§(?:0(?:\.[1-9]\d*)+|[1-9]\d*(?:\.[1-9]\d*)*)$/;

const KINDS = new Set(["heading", "paragraph", "item"]);
const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM_LINE = /^(\s*)([-*+]|\d+[.)])(?:\s+(.*))?$/;
const FENCE_LINE = /^\s*(```|~~~)/;
const THEMATIC_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
// Above this many cells the exact LCS table is too large; a greedy match is used instead.
const LCS_CELL_LIMIT = 40_000_000;

export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function indentWidth(whitespace) {
  let width = 0;
  for (const character of whitespace) width += character === "\t" ? 4 : 1;
  return width;
}

// Splits plan markdown into ordered blocks: headings, paragraphs and list items.
// Fenced code is kept as one paragraph. Blank lines, thematic breaks and empty
// items contribute no clause.
export function parsePlanBlocks(markdown) {
  if (typeof markdown !== "string") throw new TypeError("Plan markdown must be a string.");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let current = null;
  let fenceMarker = null;
  let fenceParts = [];

  const flush = () => {
    if (!current) return;
    const text = normalizeText(current.parts.join(" "));
    if (text) blocks.push({ kind: current.kind, indent: current.indent, text });
    current = null;
  };
  const flushFence = () => {
    const text = normalizeText(fenceParts.join(" "));
    if (text) blocks.push({ kind: "paragraph", indent: 0, text });
    fenceMarker = null;
    fenceParts = [];
  };

  for (const line of lines) {
    if (fenceMarker !== null) {
      if (line.trim().startsWith(fenceMarker)) flushFence();
      else fenceParts.push(line.trim());
      continue;
    }
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      flush();
      fenceMarker = fence[1];
      fenceParts = [];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (THEMATIC_LINE.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flush();
      const text = normalizeText(heading[2]);
      if (text) blocks.push({ kind: "heading", level: heading[1].length, indent: 0, text });
      continue;
    }
    const item = ITEM_LINE.exec(line);
    if (item) {
      flush();
      current = { kind: "item", indent: indentWidth(item[1]), parts: [item[3] ?? ""] };
      continue;
    }
    // Lazy continuation: plain text joins the open paragraph or list item.
    if (current) {
      current.parts.push(line.trim());
      continue;
    }
    current = { kind: "paragraph", indent: 0, parts: [line.trim()] };
  }
  flush();
  if (fenceMarker !== null) flushFence();
  return blocks;
}

// Assigns structural ids to a fresh plan (no previous version).
function structuralIds(blocks) {
  const root = { kind: "root", children: 0, num: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  return blocks.map((block) => {
    if (block.kind === "heading") {
      while (stack.length > 1 && !(top().kind === "heading" && top().level < block.level)) stack.pop();
    } else if (block.kind === "item") {
      while (stack.length > 1 && top().kind === "item" && top().indent >= block.indent) stack.pop();
    } else {
      while (stack.length > 1 && top().kind === "item") stack.pop();
    }
    const parent = top();
    parent.children += 1;
    const num = [...parent.num, parent.children];
    if (block.kind !== "paragraph") {
      stack.push({ kind: block.kind, level: block.level, indent: block.indent, num, children: 0 });
    }
    return `§${num.join(".")}`;
  });
}

function keyOf(kind, text) {
  return `${kind}\u0001${normalizeText(text)}`;
}

function validatePrevious(list) {
  const seen = new Set();
  return list.map((clause) => {
    if (!clause || typeof clause !== "object") throw new TypeError("Previous clauses must be objects.");
    const { id, text, kind, status = "active" } = clause;
    if (typeof id !== "string" || !CLAUSE_ID_PATTERN.test(id)) throw new TypeError(`Invalid previous clause id: ${String(id)}`);
    if (seen.has(id)) throw new TypeError(`Duplicate previous clause id: ${id}`);
    if (!KINDS.has(kind)) throw new TypeError(`Invalid previous clause kind for ${id}: ${String(kind)}`);
    if (status !== "active" && status !== "withdrawn") throw new TypeError(`Invalid previous clause status for ${id}`);
    seen.add(id);
    return { id, text: normalizeText(text), kind, status };
  });
}

function normalizePrevious(previous) {
  if (previous === undefined || previous === null) return null;
  if (typeof previous === "string") return numberPlan(previous).clauses;
  if (Array.isArray(previous)) return validatePrevious(previous);
  if (typeof previous === "object" && Array.isArray(previous.clauses)) return validatePrevious(previous.clauses);
  throw new TypeError("previous must be plan markdown, a clause array, or a numbering result with clauses.");
}

// Exact LCS over key arrays, with a greedy fallback for very large plans.
// Returns increasing [indexInA, indexInB] pairs.
export function matchKeys(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const pairs = [];
  for (let i = 0; i < start; i += 1) pairs.push([i, i]);

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= LCS_CELL_LIMIT) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  } else if (n > 0 && m > 0) {
    const positions = new Map();
    for (let j = 0; j < m; j += 1) {
      const key = b[start + j];
      if (!positions.has(key)) positions.set(key, []);
      positions.get(key).push(j);
    }
    const cursors = new Map();
    let lastJ = -1;
    for (let i = 0; i < n; i += 1) {
      const list = positions.get(a[start + i]);
      if (!list) continue;
      let cursor = cursors.get(a[start + i]) ?? 0;
      while (cursor < list.length && list[cursor] <= lastJ) cursor += 1;
      if (cursor < list.length) {
        pairs.push([start + i, start + list[cursor]]);
        lastJ = list[cursor];
        cursor += 1;
      }
      cursors.set(a[start + i], cursor);
    }
  }

  for (let t = 0; t < a.length - endA; t += 1) pairs.push([endA + t, endB + t]);
  return pairs;
}

function nextChildId(parentId, used) {
  const prefix = `${parentId}.`;
  let max = 0;
  for (const id of used) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^[1-9]\d*$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${parentId}.${max + 1}`;
}

function renumber(blocks, previous) {
  const used = new Set(previous.map((clause) => clause.id));
  const activeIndexes = [];
  previous.forEach((clause, index) => {
    if (clause.status === "active") activeIndexes.push(index);
  });
  const pairs = matchKeys(
    activeIndexes.map((index) => keyOf(previous[index].kind, previous[index].text)),
    blocks.map((block) => keyOf(block.kind, block.text)),
  );
  const anchors = pairs.map(([a, b]) => [activeIndexes[a], b]);

  const clauses = [];
  const changes = [];
  const state = { anchorId: null, runParent: null, insideRun: false };

  const insertClause = (block) => {
    const parent = state.insideRun ? state.runParent : (state.anchorId ?? "§0");
    const id = nextChildId(parent, used);
    used.add(id);
    state.runParent = parent;
    state.insideRun = true;
    clauses.push({ id, text: block.text, kind: block.kind, status: "active" });
    changes.push({ type: "clause.added", clause: id, newText: block.text });
  };
  const anchorClause = (id, block) => {
    state.anchorId = id;
    state.insideRun = false;
    clauses.push({ id, text: block.text, kind: block.kind, status: "active" });
  };
  const emitGap = (oldStart, oldEnd, newStart, newEnd) => {
    const oldActive = [];
    for (let i = oldStart; i < oldEnd; i += 1) if (previous[i].status === "active") oldActive.push(i);
    const paired = new Map();
    const pairedOld = new Set();
    for (let k = 0; k < Math.min(oldActive.length, newEnd - newStart); k += 1) {
      const oldIndex = oldActive[k];
      const newIndex = newStart + k;
      if (previous[oldIndex].kind !== blocks[newIndex].kind) break;
      paired.set(newIndex, oldIndex);
      pairedOld.add(oldIndex);
    }
    for (let j = newStart; j < newEnd; j += 1) {
      const block = blocks[j];
      if (!paired.has(j)) {
        insertClause(block);
        continue;
      }
      const old = previous[paired.get(j)];
      clauses.push({ id: old.id, text: block.text, kind: block.kind, status: "active" });
      if (old.text !== block.text) {
        changes.push({ type: "clause.changed", clause: old.id, oldText: old.text, newText: block.text });
      }
      state.anchorId = old.id;
      state.insideRun = false;
    }
    for (let i = oldStart; i < oldEnd; i += 1) {
      if (pairedOld.has(i)) continue;
      const old = previous[i];
      if (old.status === "active") {
        clauses.push({ id: old.id, text: old.text, kind: old.kind, status: "withdrawn" });
        changes.push({ type: "clause.withdrawn", clause: old.id, oldText: old.text });
      } else {
        clauses.push({ id: old.id, text: old.text, kind: old.kind, status: "withdrawn" });
      }
    }
  };

  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldIndex, newIndex] of anchors) {
    emitGap(oldCursor, oldIndex, newCursor, newIndex);
    anchorClause(previous[oldIndex].id, blocks[newIndex]);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  emitGap(oldCursor, previous.length, newCursor, blocks.length);
  return { clauses, changes };
}

// numberPlan(markdown, previous?) -> { clauses: [{ id, text, kind, status }], changes: [...] }
// previous may be plan markdown, a clause array, or an earlier numberPlan result.
export function numberPlan(markdown, previous) {
  const blocks = parsePlanBlocks(markdown);
  const prior = normalizePrevious(previous);
  if (!prior) {
    const ids = structuralIds(blocks);
    const clauses = blocks.map((block, index) => ({ id: ids[index], text: block.text, kind: block.kind, status: "active" }));
    return {
      clauses,
      changes: clauses.map((clause) => ({ type: "clause.added", clause: clause.id, newText: clause.text })),
    };
  }
  return renumber(blocks, prior);
}
