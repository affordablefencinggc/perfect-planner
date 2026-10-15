import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceDiscovery,
  buildWorkspaceStructureTree,
  workspaceDiscoveryLimits,
} from "../src/engine/workspaceDiscoveryEngine.js";

const file = (path) => ({ path });

test("a new intake starts with questions and no fabricated answers", () => {
  const map = buildWorkspaceDiscovery(null);
  assert.equal(map.state, "empty");
  assert.equal(map.observedFiles, 0);
  assert.equal(map.categories.length, 8);
  assert.equal(
    map.categories.flatMap((category) => category.findings).length,
    0,
  );
  assert.ok(
    map.categories
      .find((category) => category.id === "A04")
      .questions.some((question) => /multi-tenant/.test(question)),
  );
});

test("metadata creates observed facts and clearly weaker signals", () => {
  const map = buildWorkspaceDiscovery(
    {
      files: [
        file("package.json"),
        file("vite.config.mjs"),
        file("src/main.jsx"),
        file("src-tauri/tauri.conf.json"),
        file("tests/app.test.jsx"),
        file(".github/workflows/ci.yml"),
      ],
      skipped: [],
    },
    { appName: "Example" },
  );
  assert.equal(map.state, "discovering");
  assert.equal(map.appName, "Example");
  assert.ok(
    map.categories
      .find((category) => category.id === "A02")
      .findings.some(
        (finding) =>
          finding.label === "Vite build configuration" &&
          finding.certainty === "observed",
      ),
  );
  assert.ok(
    map.categories
      .find((category) => category.id === "A02")
      .findings.some(
        (finding) =>
          finding.label === "React-style component files" &&
          finding.certainty === "signal",
      ),
  );
  assert.equal(
    map.categories.find((category) => category.id === "A04").state,
    "unanswered",
  );
});

test("tenant-named paths never become verified architecture truth", () => {
  const map = buildWorkspaceDiscovery({
    files: [file("src/tenants/tenantStore.ts")],
    skipped: [],
  });
  const tenancy = map.categories
    .find((category) => category.id === "A04")
    .findings.find((finding) => /Multi-tenancy/.test(finding.label));
  assert.equal(tenancy.certainty, "signal");
  assert.match(tenancy.detail, /requires a contract and proof/);
});

test("the exact indexed folder hierarchy is rebuilt top down", () => {
  const tree = buildWorkspaceStructureTree(
    {
      files: [
        file("src/components/App.jsx"),
        file("src/engine/run.js"),
        file("src/main.jsx"),
        file("package.json"),
      ],
      skipped: [],
    },
    { appName: "Sample" },
  );
  assert.equal(tree.state, "ready");
  assert.equal(tree.root.name, "Sample");
  assert.deepEqual(
    tree.root.files.map((item) => item.name),
    ["package.json"],
  );
  assert.deepEqual(
    tree.root.children.map((item) => item.path),
    ["src"],
  );
  assert.deepEqual(
    tree.root.children[0].children.map((item) => item.path),
    ["src/components", "src/engine"],
  );
  assert.equal(tree.fileCount, 4);
});

function structureRows(root) {
  const rows = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    rows.push([
      node.id,
      node.path,
      node.depth,
      node.files.map((item) => item.path),
    ]);
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      pending.push(node.children[index]);
  }
  return rows;
}

test("multi-thousand-file maps remain deterministic regardless of census order", () => {
  const paths = Array.from({ length: 5_000 }, (_, index) => {
    const folder = `packages/p${String(index % 250).padStart(3, "0")}/src`;
    return file(`${folder}/module-${String(index).padStart(5, "0")}.js`);
  });
  const forward = buildWorkspaceStructureTree(
    { files: paths, skipped: [] },
    { appName: "Large workspace" },
  );
  const reverse = buildWorkspaceStructureTree(
    { files: paths.slice().reverse(), skipped: [] },
    { appName: "Large workspace" },
  );

  assert.equal(forward.state, "ready");
  assert.equal(forward.fileCount, 5_000);
  assert.equal(forward.integrity.accepted, true);
  assert.deepEqual(structureRows(forward.root), structureRows(reverse.root));
  assert.equal(forward.root.children[0].path, "packages");
  assert.equal(forward.directoryCount, 501);
});

test("a tree at the depth ceiling is finalized iteratively and fully frozen", () => {
  const folders = Array.from(
    { length: workspaceDiscoveryLimits.maxDepth },
    () => "d",
  );
  const tree = buildWorkspaceStructureTree({
    files: [file(`${folders.join("/")}/leaf.js`)],
    skipped: [],
  });

  assert.equal(tree.state, "ready");
  assert.equal(tree.directoryCount, workspaceDiscoveryLimits.maxDepth);
  let node = tree.root;
  let visited = 0;
  while (node.children.length) {
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Object.isFrozen(node.children), true);
    assert.equal(Object.isFrozen(node.files), true);
    node = node.children[0];
    visited += 1;
  }
  assert.equal(visited, workspaceDiscoveryLimits.maxDepth);
  assert.equal(node.depth, workspaceDiscoveryLimits.maxDepth);
  assert.equal(node.files[0].name, "leaf.js");
});

test("over-depth and oversized censuses fail closed without exposing partial findings or nodes", () => {
  const overDepth = Array.from(
    { length: workspaceDiscoveryLimits.maxDepth + 1 },
    () => "d",
  ).join("/");
  const depthCensus = {
    files: [file(`${overDepth}/leaf.js`), file("package.json")],
    skipped: [],
  };
  const tree = buildWorkspaceStructureTree(depthCensus);
  const discovery = buildWorkspaceDiscovery(depthCensus);

  assert.equal(tree.state, "invalid");
  assert.equal(tree.fileCount, 0);
  assert.equal(tree.root.children.length, 0);
  assert.equal(tree.integrity.reason, "path-depth-limit-exceeded");
  assert.equal(discovery.state, "invalid");
  assert.equal(discovery.observedFiles, 0);
  assert.equal(
    discovery.categories.flatMap((category) => category.findings).length,
    0,
  );
  assert.equal(discovery.integrity.reason, "path-depth-limit-exceeded");

  const tooMany = Array.from(
    { length: workspaceDiscoveryLimits.maxFiles + 1 },
    (_, index) => file(`f-${index}.js`),
  );
  const bounded = buildWorkspaceStructureTree({ files: tooMany, skipped: [] });
  assert.equal(bounded.state, "invalid");
  assert.equal(bounded.integrity.reason, "file-count-limit-exceeded");
  assert.equal(bounded.fileCount, 0);
});

test("directory fan-out stops at its independent node budget", () => {
  const filesNeeded = Math.ceil(
    (workspaceDiscoveryLimits.maxDirectories + 1) / 6,
  );
  const paths = Array.from({ length: filesNeeded }, (_, index) =>
    file(`root-${index}/a/b/c/d/e/leaf.js`),
  );
  const tree = buildWorkspaceStructureTree({ files: paths, skipped: [] });

  assert.equal(tree.state, "invalid");
  assert.equal(tree.integrity.reason, "directory-count-limit-exceeded");
  assert.equal(tree.directoryCount, 0);
  assert.equal(tree.fileCount, 0);
});

test("duplicates, portable-name ambiguity, traversal, and file-folder collisions are refused as a whole", () => {
  const cases = [
    {
      files: [file("src/app.js"), file("src\\app.js")],
      reason: "duplicate-file-path",
    },
    {
      files: [file("SRC/app.js"), file("src/app.js")],
      reason: "ambiguous-file-path",
    },
    {
      files: [file("SRC/a.js"), file("src/b.js")],
      reason: "ambiguous-directory-path",
    },
    {
      files: [file("src/../secret.js"), file("package.json")],
      reason: "invalid-relative-path",
    },
    { files: [file("/absolute.js")], reason: "invalid-relative-path" },
    {
      files: [file("src"), file("src/app.js")],
      reason: "file-directory-collision",
    },
    {
      files: [file("SRC"), file("src/app.js")],
      reason: "file-directory-collision",
    },
  ];

  for (const fixture of cases) {
    const tree = buildWorkspaceStructureTree({
      files: fixture.files,
      skipped: [],
    });
    assert.equal(tree.state, "invalid");
    assert.equal(tree.integrity.reason, fixture.reason);
    assert.equal(tree.integrity.acceptedFileCount, 0);
    assert.equal(tree.fileCount, 0);
    assert.deepEqual(tree.root.files, []);
    assert.deepEqual(tree.root.children, []);
  }
});

test("malicious metadata accessors become a stable refusal instead of crashing discovery", () => {
  const record = {};
  Object.defineProperty(record, "path", {
    get() {
      throw new Error("hostile getter");
    },
  });

  assert.doesNotThrow(() => buildWorkspaceStructureTree({ files: [record] }));
  const tree = buildWorkspaceStructureTree({ files: [record] });
  assert.equal(tree.state, "invalid");
  assert.equal(tree.integrity.reason, "invalid-file-record");

  const poisonedMetadata = { path: "safe.js" };
  Object.defineProperty(poisonedMetadata, "category", {
    get() {
      throw new Error("hostile category getter");
    },
  });
  const metadataTree = buildWorkspaceStructureTree({
    files: [poisonedMetadata],
  });
  assert.equal(metadataTree.state, "invalid");
  assert.equal(metadataTree.integrity.reason, "invalid-file-record");
});

const findingsOf = (map, id) =>
  map.categories.find((category) => category.id === id).findings;
const findingIds = (map) =>
  map.categories.flatMap((category) => category.findings.map((item) => item.id));

test("Git is detected from the skipped .git folder or a root .git file without indexing its contents", () => {
  const skippedFolder = buildWorkspaceDiscovery({
    files: [file("package.json")],
    skipped: [{ path: ".git", reason: "generated-or-dependency-directory-excluded", size: null }],
  });
  const git = findingsOf(skippedFolder, "A01").find((item) => item.id === "S003");
  assert.ok(git, "a skipped root .git folder must produce S003");
  assert.equal(git.certainty, "observed");
  assert.deepEqual([...git.evidence], [".git"]);
  assert.match(git.detail, /not read/);

  const worktreeFile = buildWorkspaceDiscovery({ files: [file(".git"), file("package.json")], skipped: [] });
  assert.ok(findingIds(worktreeFile).includes("S003"), "a root .git file (worktree) counts as Git");

  const nested = buildWorkspaceDiscovery({
    files: [file("package.json")],
    skipped: [{ path: "vendor/lib/.git", reason: "generated-or-dependency-directory-excluded", size: null }],
  });
  assert.equal(findingIds(nested).includes("S003"), false, "a nested repository is not the app's own Git");
  assert.equal(findingIds(buildWorkspaceDiscovery({ files: [file("package.json")], skipped: [] })).includes("S003"), false);
  const hostile = { files: [file("package.json")] };
  Object.defineProperty(hostile, "skipped", { get() { throw new Error("hostile skipped getter"); } });
  assert.doesNotThrow(() => buildWorkspaceDiscovery(hostile));
});

test("Tauri capability and permission files are desktop app permissions, not user auth or security policy", () => {
  const map = buildWorkspaceDiscovery({
    files: [
      file("src-tauri/tauri.conf.json"),
      file("src-tauri/capabilities/main-read-only.json"),
      file("src-tauri/permissions/autogenerated/read.toml"),
      file("src-tauri/permissions/git.json"),
    ],
    skipped: [],
  });
  const ids = findingIds(map);
  assert.equal(ids.includes("S031"), false, "no user-auth finding from Tauri permissions");
  assert.equal(ids.includes("S051"), false, "no security-policy finding from Tauri capabilities");
  const desktop = findingsOf(map, "A06").find((item) => item.id === "S052");
  assert.ok(desktop);
  assert.equal(desktop.label, "Desktop app permission files");
  assert.equal(desktop.certainty, "signal");
  assert.equal(desktop.evidenceCount, 3);
  assert.match(desktop.detail, /not user sign-in/);

  const realAuth = buildWorkspaceDiscovery({ files: [file("src/auth/session.ts"), file("src/security/policy.ts")], skipped: [] });
  assert.ok(findingIds(realAuth).includes("S031"));
  assert.ok(findingIds(realAuth).includes("S051"));
});

test(".openai/hosting.json is low-confidence hosting metadata that keeps its area open for review", () => {
  const map = buildWorkspaceDiscovery({
    files: [file(".openai/hosting.json"), file("tests/app.test.mjs"), file(".github/workflows/ci.yml")],
    skipped: [],
  });
  const area = map.categories.find((category) => category.id === "A07");
  assert.equal(area.findings.some((item) => item.id === "S062"), false, "a hosting file is not deployment configuration");
  const hosting = area.findings.find((item) => item.id === "S063");
  assert.ok(hosting);
  assert.equal(hosting.label, "Hosting metadata file");
  assert.equal(hosting.certainty, "signal");
  assert.equal(area.state, "signal", "an area with any low-confidence finding needs review, even beside observed facts");

  const docker = buildWorkspaceDiscovery({ files: [file("Dockerfile")], skipped: [] });
  const deploy = findingsOf(docker, "A07").find((item) => item.id === "S062");
  assert.equal(deploy.certainty, "observed");
  assert.equal(docker.categories.find((category) => category.id === "A07").state, "observed");
});

test("a worker-named folder alone is not a worker boundary", () => {
  const lone = buildWorkspaceDiscovery({ files: [file("worker/index.js"), file("package.json")], skipped: [] });
  assert.equal(findingIds(lone).includes("S023"), false);
  const unknown = findingsOf(lone, "A08").find((item) => item.id === "S080");
  assert.ok(unknown, "the worker folder is left as an open question");
  assert.equal(unknown.certainty, "signal");

  for (const corroboration of ["wrangler.toml", "worker/wrangler.jsonc", "worker/package.json", "src/sync.worker.js"]) {
    const map = buildWorkspaceDiscovery({ files: [file("worker/index.js"), file(corroboration)], skipped: [] });
    assert.ok(findingIds(map).includes("S023"), `${corroboration} corroborates a worker boundary`);
  }
});
