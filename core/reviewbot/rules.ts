import { findSecrets } from "../secrets/index";
import { isTestFile } from "../release/risk";
import { parsePatch } from "./patch";

// Our own review bot: one pure function from PR facts to a verdict on the exact head.
// No network, no clock, no file access, so the same facts always give the same text.

export type Verdict = "GO" | "NO-GO" | "HOLD" | "WAIT";
export type Severity = "block" | "hold" | "wait" | "warn";

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** GitHub leaves this out for huge or binary files. */
  patch?: string;
}

export interface Sizes {
  jsTotalGzip: number;
  jsMaxGzip: number;
  cssTotalGzip: number;
  cssMaxGzip: number;
}

export interface Budgets {
  maxTotalJavaScriptGzipBytes: number;
  maxIndividualJavaScriptGzipBytes: number;
  maxTotalStylesheetGzipBytes: number;
  maxIndividualStylesheetGzipBytes: number;
}

export interface PrFacts {
  number: number;
  headSha: string;
  baseSha: string;
  draft: boolean;
  body: string;
  files: ChangedFile[];
  authorEmails: string[];
  checks: Array<{ name: string; conclusion: "success" | "failure" | "pending" | "skipped" | "neutral" }>;
  /** Green checks a ready PR must have; from the project's merge rule. */
  expectedGreen?: number;
  mergeable?: boolean | null;
  sizes?: Sizes;
  budgets?: Budgets;
}

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
}

export interface Review {
  number: number;
  headSha: string;
  baseSha: string;
  verdict: Verdict;
  findings: Finding[];
  notes: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const NOREPLY = /@users\.noreply\.github\.com$|^noreply@(?:anthropic\.com|github\.com)$/i;
const ATTRIBUTION = /<!--\s*claude-projects-attribution:/;

const GATE_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/^core\/gate\//, "core/gate"],
  [/^\.github\//, "CI config"],
  [/^core\/reviewbot\/|^scripts\/review-bot\.mjs$/, "the review bot itself"],
  [/(^|\/)(key-?store|keychain|keyring|vault|dpapi)[^/]*$/i, "key storage"],
  [/^core\/release\/(?:secrets|allowlist|pushProtection|protect)[^/]*$|^core\/release\/hooks\/|^core\/secrets\//, "push-scan"],
  [/secret-allowlist/, "push-scan allowlist"],
  [/repo-scan[^/]*\.test\.ts$|(^|\/)fixtures\/[^/]*secret/i, "push-scan fixtures"],
];

const GENERATED: ReadonlyArray<{ target: string; source: string }> = [
  { target: "core/release/hooks/secrets-detector.mjs", source: "core/secrets/index.ts" },
  { target: "core/release/hooks/git-exec.mjs", source: "core/exec/executable.ts" },
  { target: "core/release/hooks/git-runner.mjs", source: "core/worktrees/git.ts" },
];

const COST_LINES: ReadonlyArray<[RegExp, string]> = [
  [/\bmacos[-\w.]*/i, "macOS runner (macOS is dropped everywhere)"],
  [/self-hosted/i, "self-hosted runner"],
  // Larger runners are picked by group or label, not by an image name.
  [/\bgroup\s*:|\blabels?\s*:/i, "runner group or label (larger or self-hosted runner)"],
  [/\b(?:ubuntu|windows)-[\w.-]*(?:large|xlarge|\d+-?cores?|\d+x\b)[\w.-]*/i, "larger paid runner"],
];
const INSTALLER_LINES = /\btauri(?::|\s+)build\b|\bnpm run tauri\b|\bcargo tauri\b|\bpackage:installer|\bmakensis\b|\bdmg\b/i;

const PHOTO = /\.(?:jpe?g|heic|heif)$/i;
const ENV_FILE = /(^|\/)\.env(?:\.[^/]*)?$/i;
const BUDGET_LINE = /\b(max(?:Total|Individual)(?:JavaScript|Stylesheet)GzipBytes)\s*:\s*([\d* ]+)/;

function evalBudgetNumber(text: string): number | undefined {
  const parts = text.trim().split("*").map((p) => Number(p.trim()));
  return parts.length && parts.every((n) => Number.isFinite(n) && n > 0) ? parts.reduce((a, b) => a * b, 1) : undefined;
}

const normal = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const paths = (f: ChangedFile) => [f.path, ...(f.previousPath ? [f.previousPath] : [])].map(normal);

export function reviewPullRequest(facts: PrFacts): Review {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const add = (rule: string, severity: Severity, message: string, file?: string, line?: number) =>
    findings.push({ rule, severity, message, ...(file ? { file } : {}), ...(line ? { line } : {}) });

  // 1. The verdict is only worth something with a real head.
  if (!SHA.test(facts.headSha) || !SHA.test(facts.baseSha)) add("head", "block", "The head or base sha is missing or malformed, so no verdict can be bound to it.");

  const files = facts.files.map((f) => ({ ...f, path: normal(f.path), ...(f.previousPath ? { previousPath: normal(f.previousPath) } : {}) }));
  const changed = new Set(files.flatMap(paths));

  for (const file of files) {
    // A missing patch on a text file means the bot could not read it; never guess clean.
    const binaryLike = PHOTO.test(file.path) || /\.(?:png|gif|webp|ico|woff2?|zip|gz|pdf)$/i.test(file.path);
    if (file.patch === undefined && file.status !== "removed" && !binaryLike && file.additions + file.deletions > 0) {
      add("unreadable", "block", "GitHub sent no diff for this file (too large), so it could not be checked.", file.path);
    }
    const parsed = file.patch ? parsePatch(file.patch) : { added: [], removed: [] };

    // 2. Cost rules, on workflow files only.
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(file.path)) {
      const isRelease = /release/i.test(file.path);
      for (const l of parsed.added) {
        const bare = l.text.replace(/#.*$/, "");
        for (const [re, why] of COST_LINES) if (re.test(bare)) add("cost", "block", `Adds a ${why}.`, file.path, l.line);
        if (!isRelease && INSTALLER_LINES.test(bare)) add("cost", "block", "Adds an installer or app build to a workflow that is not the release workflow (needs the user's go).", file.path, l.line);
      }
    }

    // 3. Gate, CI, key storage and push-scan files need the person's typed OK.
    for (const p of paths(file)) {
      // Windows checkouts are case-insensitive and accept backslashes, so Core\\Gate\\x.ts is core/gate/x.ts there.
      const folded = p.replace(/\\/g, "/").toLowerCase();
      const hit = GATE_PATHS.find(([re]) => re.test(p) || re.test(folded));
      if (hit) {
        add("gate-files", "hold", `Touches ${hit[1]}: the user must type the OK in the project thread.`, p);
        break;
      }
    }

    // 4. A budget number being raised is the user's call.
    if (/^scripts\/verify-performance-budget\.mjs$/.test(file.path)) {
      const oldValues = new Map<string, number>();
      for (const l of parsed.removed) {
        const m = BUDGET_LINE.exec(l.text);
        const v = m && evalBudgetNumber(m[2]);
        if (m && v) oldValues.set(m[1], v);
      }
      for (const l of parsed.added) {
        const m = BUDGET_LINE.exec(l.text);
        const v = m && evalBudgetNumber(m[2]);
        if (m && v && v > (oldValues.get(m[1]) ?? 0)) add("budget", "hold", `Raises ${m[1]}: budget raises are the user's call.`, file.path, l.line);
      }
    }

    // 5. Secrets, env files, photos.
    if (ENV_FILE.test(file.path) && !/\.(?:example|sample|template)$/i.test(file.path) && file.status !== "removed") add("secrets", "block", "Adds an .env file.", file.path);
    if (PHOTO.test(file.path) && file.status !== "removed") add("personal-data", "hold", "Adds a photo; never commit real people's photos, a person must confirm it is not one.", file.path);
    for (const l of parsed.added) {
      for (const m of findSecrets(file.path, l.text)) add("secrets", "block", `Looks like a secret (${m.rule}).`, file.path, l.line);
    }
  }

  // 4b. Measured size against the budget.
  if (facts.sizes && facts.budgets) {
    const checks: Array<[string, number, number]> = [
      ["JS total (gzip)", facts.sizes.jsTotalGzip, facts.budgets.maxTotalJavaScriptGzipBytes],
      ["biggest JS file (gzip)", facts.sizes.jsMaxGzip, facts.budgets.maxIndividualJavaScriptGzipBytes],
      ["CSS total (gzip)", facts.sizes.cssTotalGzip, facts.budgets.maxTotalStylesheetGzipBytes],
      ["biggest CSS file (gzip)", facts.sizes.cssMaxGzip, facts.budgets.maxIndividualStylesheetGzipBytes],
    ];
    for (const [name, used, limit] of checks) {
      const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
      if (used > limit) add("size", "block", `${name} is ${kib(used)}, over the ${kib(limit)} budget.`);
      else if (used > limit * 0.97) add("size", "warn", `${name} is ${kib(used)} of ${kib(limit)}: under 3 percent headroom.`);
    }
  } else {
    notes.push("Size not measured (no build was given to the bot).");
  }

  // 5b. Author email.
  for (const email of new Set(facts.authorEmails)) {
    if (!NOREPLY.test(email)) add("personal-data", "block", "A commit author email is not a GitHub no-reply address (a real email would be public).");
  }

  // 6. Tests.
  const testFiles = files.filter((f) => isTestFile(f.path));
  const coreCode = files.filter((f) => /^core\/.+\.(?:ts|mjs)$/.test(f.path) && !isTestFile(f.path) && !GENERATED.some((g) => g.target === f.path) && f.additions >= 10);
  if (coreCode.length && !testFiles.length) add("tests", "block", `Changes core code (${coreCode.map((f) => f.path).join(", ")}) without adding or changing any test.`);
  for (const t of testFiles) if (t.deletions > t.additions) add("tests", "warn", "Removes more test lines than it adds.", t.path);

  // 7. Generated files move with their source.
  for (const g of GENERATED) {
    const t = changed.has(g.target);
    const s = changed.has(g.source);
    if (t && !s) add("generated", "block", `${g.target} is generated from ${g.source}; edit the source and regenerate.`, g.target);
    if (s && !t) add("generated", "block", `${g.source} changed but ${g.target} was not regenerated.`, g.source);
  }

  // 8. Checks and mergeability.
  const red = facts.checks.filter((c) => c.conclusion === "failure");
  for (const c of red) add("checks", "block", `Check "${c.name}" is red.`);
  const pending = facts.checks.filter((c) => c.conclusion === "pending");
  const green = facts.checks.filter((c) => c.conclusion === "success").length;
  if (pending.length) add("checks", "wait", `${pending.length} check(s) still running.`);
  else if (!red.length && facts.expectedGreen !== undefined && !facts.draft && green < facts.expectedGreen) add("checks", "wait", `${green} green checks, ${facts.expectedGreen} expected on a ready PR.`);
  if (facts.mergeable === false) add("merge", "block", "Conflicts with the base branch.");

  // 9. Hygiene and draft state.
  if (!ATTRIBUTION.test(facts.body)) add("hygiene", "warn", "The PR body is missing the attribution marker.");
  if (facts.draft) notes.push("Draft: Windows checks have not run yet.");

  const order: Verdict[] = ["GO", "WAIT", "HOLD", "NO-GO"];
  let verdict: Verdict = "GO";
  for (const f of findings) {
    const v: Verdict | null = f.severity === "block" ? "NO-GO" : f.severity === "hold" ? "HOLD" : f.severity === "wait" ? "WAIT" : null;
    if (v && order.indexOf(v) > order.indexOf(verdict)) verdict = v;
  }
  return { number: facts.number, headSha: facts.headSha, baseSha: facts.baseSha, verdict, findings, notes };
}
