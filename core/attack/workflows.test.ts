// Attack 9: a fork PR that edits the workflows (the repo is public). Static checks on .github/workflows/*.yml; nothing
// here edits a workflow. A pull request from a fork runs the workflow files of the PR itself, so what protects the repo
// is what such a run can reach: the token must be read-only and no secret may be in reach, and the workflows that run
// with more power (pull_request_target, workflow_run, comments) must never check out and run the PR's own code.
//
// The rules (checkWorkflow below) are tested twice: against the real files (they must pass), and against bad
// workflows written out in this file (each must be caught), so a rule that silently stopped working would fail here.
//
// NOT RUN: the GitHub settings that sit beside these files and cannot be read from the repo ("Send write tokens to
// workflows from fork pull requests" off, "Require approval for all outside collaborators" on, a protected `release`
// environment). Only a person with admin rights can look at them.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------- a small reader for the YAML these files use

type Yaml = string | Yaml[] | { [key: string]: Yaml };
interface Line {
  indent: number;
  text: string;
}

function stripComment(raw: string): string {
  let quote = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}

const unquote = (value: string): string => {
  const v = value.trim();
  return v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
};

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = "";
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === "[" || c === "{") {
      depth += 1;
      current += c;
    } else if (c === "]" || c === "}") {
      depth -= 1;
      current += c;
    } else if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function scalarOrFlow(value: string): Yaml {
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map(scalarOrFlow);
  if (v.startsWith("{") && v.endsWith("}")) {
    const out: { [key: string]: Yaml } = {};
    for (const pair of splitFlow(v.slice(1, -1))) {
      const at = pair.indexOf(":");
      if (at > 0) out[unquote(pair.slice(0, at))] = scalarOrFlow(pair.slice(at + 1));
    }
    return out;
  }
  return unquote(v);
}

/** The block-style YAML of workflow files: maps, lists, flow lists, quoted scalars and | / > blocks. Not general YAML. */
export function parseYaml(text: string): Yaml {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const lines: Line[] = [];
  for (const line of raw) {
    const cleaned = stripComment(line).replace(/\s+$/, "");
    if (cleaned.trim() === "") lines.push({ indent: -1, text: "" });
    else lines.push({ indent: cleaned.length - cleaned.trimStart().length, text: cleaned.trimStart() });
  }
  let pos = 0;
  const skipBlank = () => {
    while (pos < lines.length && lines[pos]!.indent === -1) pos += 1;
  };

  function blockScalar(parentIndent: number, folded: boolean): string {
    const collected: string[] = [];
    let base = -1;
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent === -1) {
        collected.push("");
        pos += 1;
        continue;
      }
      if (line.indent <= parentIndent) break;
      if (base < 0) base = line.indent;
      collected.push(" ".repeat(line.indent - base) + line.text);
      pos += 1;
    }
    while (collected.length && collected[collected.length - 1] === "") collected.pop();
    return collected.join(folded ? " " : "\n");
  }

  function value(afterKey: string, parentIndent: number): Yaml {
    const v = afterKey.trim();
    if (v === "|" || v === "|-" || v === "|+") return blockScalar(parentIndent, false);
    if (v === ">" || v === ">-" || v === ">+") return blockScalar(parentIndent, true);
    if (v === "") {
      skipBlank();
      const next = lines[pos];
      if (next && (next.indent > parentIndent || (next.indent === parentIndent && next.text.startsWith("- ")))) return block(next.indent);
      return "";
    }
    return scalarOrFlow(v);
  }

  function entry(text: string): [string, string] | null {
    const m = /^("[^"]*"|'[^']*'|[^\s"'][^:]*?|[^\s"'])\s*:(?:\s+(.*)|)$/.exec(text);
    return m ? [unquote(m[1]!), m[2] ?? ""] : null;
  }

  function block(indent: number): Yaml {
    skipBlank();
    if (lines[pos]?.text.startsWith("- ") || lines[pos]?.text === "-") {
      const list: Yaml[] = [];
      while (pos < lines.length) {
        skipBlank();
        const line = lines[pos];
        if (!line || line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;
        const rest = line.text.slice(2);
        const asEntry = rest.trim() === "" ? null : entry(rest);
        if (asEntry) {
          // "- key: value" starts a map whose other keys sit two columns further in.
          const itemIndent = indent + 2;
          lines[pos] = { indent: itemIndent, text: rest };
          list.push(block(itemIndent));
        } else {
          pos += 1;
          list.push(rest.trim() === "" ? block(indent + 2) : scalarOrFlow(rest));
        }
      }
      return list;
    }
    const map: { [key: string]: Yaml } = {};
    while (pos < lines.length) {
      skipBlank();
      const line = lines[pos];
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new Error(`unexpected indent: ${line.text}`);
      const kv = entry(line.text);
      if (!kv) throw new Error(`cannot read this line: ${line.text}`);
      pos += 1;
      map[kv[0]] = value(kv[1], indent);
    }
    return map;
  }

  skipBlank();
  return block(lines[pos]?.indent ?? 0);
}

// ---------------------------------------------------------------- the rules

type Map = { [key: string]: Yaml };
const isMap = (v: Yaml | undefined): v is Map => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: Yaml | undefined): Yaml[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Events that run with the repository's own power (secrets, write token) or on behalf of someone else's change. */
const PR_EVENTS = ["pull_request", "pull_request_target"];
const UNTRUSTED_EVENTS = ["pull_request_target", "workflow_run", "issue_comment", "pull_request_review", "pull_request_review_comment", "discussion_comment"];
/** Where text written by a stranger ends up if a checkout names it: the PR head, a fork, a ref from a comment. */
const ATTACKER_REF = /github\.event\.pull_request\.(head|merge_commit_sha)|github\.head_ref|refs\/pull\/|workflow_run\.(head_|pull_requests)|github\.event\.(issue|comment|review)\b|github\.event\.inputs|inputs\./;
/** Fields of an event that a stranger writes (titles, bodies, branch names, commit messages). */
const ATTACKER_TEXT = /\$\{\{[^}]*(github\.head_ref|github\.event\.(issue|pull_request|comment|review|review_comment|discussion|pages|commits|head_commit|workflow_run)[^}]*\.(title|body|label|ref|name|email|message|head_ref|default_branch|head_branch|display_title)\b)[^}]*\}\}/;

function triggers(doc: Map): string[] {
  const on = doc.on ?? doc["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === "string");
  return isMap(on) ? Object.keys(on) : [];
}

function writes(permissions: Yaml | undefined): string[] {
  if (permissions === undefined) return [];
  if (typeof permissions === "string") return permissions === "write-all" ? ["write-all"] : [];
  if (isMap(permissions)) return Object.entries(permissions).filter(([, level]) => level === "write").map(([name]) => name);
  return [];
}

/** Every problem the rules find in one workflow file's text. An empty list is a pass. */
export function checkWorkflow(text: string): string[] {
  const problems: string[] = [];
  const doc = parseYaml(text);
  if (!isMap(doc)) return ["the file is not a workflow (no top-level map)"];
  const events = triggers(doc);
  if (events.length === 0) problems.push("no trigger found");
  const jobs = isMap(doc.jobs) ? doc.jobs : {};
  const steps = (job: Yaml): Map[] => (isMap(job) ? asList(job.steps).filter(isMap) : []);
  const powerful = events.filter((e) => UNTRUSTED_EVENTS.includes(e));
  const prRun = events.some((e) => PR_EVENTS.includes(e));

  // 1. A run with extra power must never check out, and so never run, a stranger's code.
  if (powerful.length) {
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of steps(job)) {
        if (typeof step.uses !== "string" || !/^actions\/checkout@/.test(step.uses)) continue;
        const withs = isMap(step.with) ? step.with : {};
        for (const key of ["ref", "repository"]) {
          const given = withs[key];
          if (typeof given === "string" && ATTACKER_REF.test(given)) problems.push(`${powerful.join("/")} workflow checks out the change under review (job ${name}, ${key}: ${given}); it would run a stranger's code with the repository's power`);
        }
      }
    }
  }

  // 2. A run for a pull request has a read-only token and no secrets, whatever the PR does to the file.
  if (prRun) {
    const topDeclared = doc.permissions !== undefined;
    const allJobsDeclare = Object.values(jobs).length > 0 && Object.values(jobs).every((job) => isMap(job) && job.permissions !== undefined);
    if (!topDeclared && !allJobsDeclare) problems.push("a pull_request workflow does not declare its token permissions (the default depends on a repository setting)");
    const granted = [...writes(doc.permissions), ...Object.values(jobs).flatMap((job) => (isMap(job) ? writes(job.permissions) : []))];
    if (granted.length) problems.push(`a pull_request workflow asks for write access (${[...new Set(granted)].join(", ")})`);
    const uses = text.match(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g) ?? [];
    for (const use of uses) if (!/secrets\.GITHUB_TOKEN$/.test(use.trim())) problems.push(`a pull_request workflow reads a secret (${use.replace(/\$\{\{\s*/, "")})`);
    if (/^\s*secrets:\s*inherit\s*$/m.test(text)) problems.push("a pull_request workflow passes every secret on (secrets: inherit)");
    for (const [name, job] of Object.entries(jobs)) {
      const runsOn = isMap(job) ? job["runs-on"] : undefined;
      if (asList(runsOn).some((r) => typeof r === "string" && /self-hosted/i.test(r))) problems.push(`a pull_request job runs on a self-hosted machine (job ${name}); a stranger's code would run on it`);
    }
  }

  // 3. Text a stranger writes must not be pasted into a shell script or a script action.
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of steps(job)) {
      const scripts = [step.run, isMap(step.with) ? step.with.script : undefined].filter((s): s is string => typeof s === "string");
      for (const script of scripts) if (ATTACKER_TEXT.test(script)) problems.push(`job ${name} pastes text a stranger writes straight into a script (${(ATTACKER_TEXT.exec(script) ?? [""])[0]})`);
    }
  }

  // 4. Where a job can write (releases, packages), a person must stand in front of it.
  if (!prRun && !powerful.length) {
    for (const [name, job] of Object.entries(jobs)) {
      if (isMap(job) && writes(job.permissions).length && job.environment === undefined) problems.push(`job ${name} has write access and no protected environment in front of it`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- the real files

const dir = path.resolve(".github", "workflows");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];

describe("attack 9: the repository's workflows hold up against a fork PR", () => {
  it("there are workflows to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s: no check-out of a stranger's code with extra power, a read-only token and no secrets on pull requests, no pasted PR text", (file) => {
    expect(checkWorkflow(fs.readFileSync(path.join(dir, file), "utf8"))).toEqual([]);
  });

  it("the reader understands the real files (so a pass above is not just 'found nothing')", () => {
    const core = parseYaml(fs.readFileSync(path.join(dir, "core-ci.yml"), "utf8")) as Map;
    expect(triggers(core)).toEqual(expect.arrayContaining(["pull_request", "push"]));
    expect(core.permissions).toEqual({ contents: "read" });
    const steps = asList((core.jobs as Map).core && ((core.jobs as Map).core as Map).steps) as Map[];
    expect(steps.some((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"))).toBe(true);
    const release = parseYaml(fs.readFileSync(path.join(dir, "release.yml"), "utf8")) as Map;
    expect(triggers(release)).not.toContain("pull_request");
    const publish = Object.values(release.jobs as Map).find((job) => isMap(job) && writes(job.permissions).length) as Map;
    expect(publish.environment).toBe("release");
    expect(writes(publish.permissions)).toEqual(["contents"]);
  });

  it("no workflow uses pull_request_target, workflow_run or a comment trigger at all (today's policy; remove this line when one is needed, with the rules above still passing)", () => {
    const used = files.flatMap((f) => triggers(parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) as Map).filter((e) => UNTRUSTED_EVENTS.includes(e)).map((e) => `${f}: ${e}`));
    expect(used).toEqual([]);
  });

  it("no workflow file is a symlink or sits outside .github/workflows with a workflow-looking name", () => {
    for (const f of files) expect(fs.lstatSync(path.join(dir, f)).isSymbolicLink(), f).toBe(false);
    expect(fs.existsSync(path.resolve(".github", "workflows", "..", "workflows.yml"))).toBe(false);
  });
});

// ---------------------------------------------------------------- the rules catch what they are for

const GOOD = `name: ok
on:
  pull_request:
    types: [opened]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

const bad: [string, string, RegExp][] = [
  [
    "pull_request_target that checks out the PR head by sha",
    `on:\n  pull_request_target:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: npm test\npermissions:\n  contents: read\n`,
    /checks out the change under review/,
  ],
  [
    "pull_request_target that checks out the fork's repository",
    `on: pull_request_target\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          repository: \${{ github.event.pull_request.head.repo.full_name }}\npermissions:\n  contents: read\n`,
    /checks out the change under review/,
  ],
  [
    "pull_request_target that checks out refs/pull/N/merge",
    `on:\n  pull_request_target:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: refs/pull/\${{ github.event.number }}/merge\npermissions:\n  contents: read\n`,
    /checks out the change under review/,
  ],
  [
    "workflow_run that checks out the triggering run's head",
    `on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.workflow_run.head_sha }}\npermissions:\n  contents: read\n`,
    /checks out the change under review/,
  ],
  [
    "an issue_comment workflow that checks out a ref taken from the comment",
    `on:\n  issue_comment:\n    types: [created]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.comment.body }}\npermissions:\n  contents: read\n`,
    /checks out the change under review/,
  ],
  ["a pull_request workflow with contents: write", GOOD.replace("contents: read", "contents: write"), /write access \(contents\)/],
  ["a pull_request workflow with write-all", GOOD.replace("permissions:\n  contents: read", "permissions: write-all"), /write access \(write-all\)/],
  ["a pull_request job asking for pull-requests: write", GOOD.replace("    runs-on: ubuntu-latest", "    permissions:\n      pull-requests: write\n    runs-on: ubuntu-latest"), /write access \(pull-requests\)/],
  ["a pull_request job asking for id-token: write", GOOD.replace("    runs-on: ubuntu-latest", "    permissions:\n      id-token: write\n    runs-on: ubuntu-latest"), /write access \(id-token\)/],
  ["a pull_request workflow that never says what its token may do", GOOD.replace("permissions:\n  contents: read\n", ""), /does not declare its token permissions/],
  ["a pull_request workflow that reads a secret", GOOD.replace("      - run: npm test", "      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"), /reads a secret \(secrets\.NPM_TOKEN\)/],
  ["a pull_request workflow that passes all secrets to a reusable workflow", GOOD.replace("    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test", "    uses: ./.github/workflows/other.yml\n    secrets: inherit"), /secrets: inherit/],
  ["a pull_request job on a self-hosted runner", GOOD.replace("runs-on: ubuntu-latest", "runs-on: [self-hosted, linux]"), /self-hosted/],
  ["the trigger written as a list", GOOD.replace("on:\n  pull_request:\n    types: [opened]", "on: [push, pull_request]").replace("contents: read", "contents: write"), /write access/],
  ["the trigger written as one word", GOOD.replace("on:\n  pull_request:\n    types: [opened]", "on: pull_request").replace("contents: read", "contents: write"), /write access/],
  ["a PR title pasted into a shell script", GOOD.replace("      - run: npm test", '      - run: echo "${{ github.event.pull_request.title }}"'), /pastes text a stranger writes/],
  ["a branch name pasted into a shell script", GOOD.replace("      - run: npm test", "      - run: git checkout ${{ github.head_ref }}"), /pastes text a stranger writes/],
  ["a comment body pasted into a script block", GOOD.replace("      - run: npm test", "      - run: |\n          set -e\n          echo ${{ github.event.comment.body }}"), /pastes text a stranger writes/],
  ["a commit message pasted into github-script", GOOD.replace("      - run: npm test", "      - uses: actions/github-script@v7\n        with:\n          script: console.log('${{ github.event.head_commit.message }}')"), /pastes text a stranger writes/],
  ["a release job with write access and no protected environment", `on:\n  push:\n    tags: [R-*]\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: gh release create\n`, /no protected environment/],
];

describe("attack 9: the rules catch the workflows they are written for", () => {
  it("control: a plain, read-only pull_request workflow passes", () => {
    expect(checkWorkflow(GOOD)).toEqual([]);
  });

  it("control: reading the PR title through an env variable (not pasted into the script) passes", () => {
    expect(checkWorkflow(GOOD.replace("      - run: npm test", '      - run: echo "$TITLE"\n        env:\n          TITLE: ${{ github.event.pull_request.title }}'))).toEqual([]);
  });

  it("control: pull_request_target that only checks out the base (no ref) and does not run it passes", () => {
    expect(checkWorkflow(GOOD.replace("on:\n  pull_request:\n    types: [opened]", "on:\n  pull_request_target:\n    types: [opened]"))).toEqual([]);
  });

  it.each(bad)("%s is caught", (_name, text, expected) => {
    const found = checkWorkflow(text);
    expect(found.join("\n"), "the rule missed it").toMatch(expected);
  });

  it("a release job with write access behind a protected environment passes", () => {
    expect(checkWorkflow(`on:\n  push:\n    tags: [R-*]\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    environment: release\n    permissions:\n      contents: write\n    steps:\n      - run: gh release create\n`)).toEqual([]);
  });
});

describe("attack 9: the reader copes with the YAML these files use", () => {
  it("reads maps, lists, flow lists, quoted strings, comments and block scalars", () => {
    const parsed = parseYaml(`# top comment
name: "A: quoted # not a comment"
on:
  push:
    branches: [main, "release/**"]  # trailing comment
jobs:
  a:
    steps:
      - uses: x/y@v1
        with:
          k: v
      - run: |
          line one
            indented
          line three
      - name: last
        run: echo done
`) as Map;
    expect(parsed.name).toBe("A: quoted # not a comment");
    expect(((parsed.on as Map).push as Map).branches).toEqual(["main", "release/**"]);
    const steps = ((parsed.jobs as Map).a as Map).steps as Map[];
    expect(steps[0]).toEqual({ uses: "x/y@v1", with: { k: "v" } });
    expect(steps[1]!.run).toBe("line one\n  indented\nline three");
    expect(steps[2]).toEqual({ name: "last", run: "echo done" });
  });
});
