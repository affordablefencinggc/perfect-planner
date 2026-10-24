// Reads a GitHub unified-diff `patch` field into its added and removed lines.
export interface PatchLine {
  line: number; // line number in the new file (added) or old file (removed)
  text: string;
}

export interface ParsedPatch {
  added: PatchLine[];
  removed: PatchLine[];
}

export function parsePatch(patch: string): ParsedPatch {
  const added: PatchLine[] = [];
  const removed: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) added.push({ line: newLine++, text: raw.slice(1) });
    else if (raw.startsWith("-")) removed.push({ line: oldLine++, text: raw.slice(1) });
    else {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
}
