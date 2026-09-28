const CATEGORY_DEFINITIONS = Object.freeze([
  {
    id: "A01",
    title: "App identity",
    side: "left",
    questions: [
      "What kind of app is this?",
      "Is Git optional, connected, or absent?",
    ],
  },
  {
    id: "A02",
    title: "Runtime & framework",
    side: "right",
    questions: [
      "Which runtime and framework are present?",
      "How is the app built and rendered?",
    ],
  },
  {
    id: "A03",
    title: "Application layers",
    side: "left",
    questions: [
      "Where are frontend, backend, native, and worker boundaries?",
      "Which layer owns each shared contract?",
    ],
  },
  {
    id: "A04",
    title: "Data, tenancy & auth",
    side: "right",
    questions: [
      "Where does data live?",
      "Is the app single-tenant or multi-tenant?",
      "How are identity and permissions enforced?",
    ],
  },
  {
    id: "A05",
    title: "Dependencies & integrations",
    side: "left",
    questions: [
      "Which manifests define dependencies?",
      "Which external services are connected?",
    ],
  },
  {
    id: "A06",
    title: "Credentials & security",
    side: "right",
    questions: [
      "Where are secret handles declared?",
      "Which security boundaries need proof?",
    ],
  },
  {
    id: "A07",
    title: "Tests, CI & deployment",
    side: "left",
    questions: [
      "Which checks prove the app?",
      "How is a release built and deployed?",
    ],
  },
  {
    id: "A08",
    title: "Unknowns & gaps",
    side: "right",
    questions: [
      "What could not be inferred from metadata?",
      "What needs content review or an owner answer?",
    ],
  },
]);

export const workspaceDiscoveryLimits = Object.freeze({
  maxFiles: 50_000,
  maxDirectories: 50_000,
  maxDepth: 512,
  maxPathCharacters: 4_096,
  maxPathSegmentCharacters: 255,
  maxTotalPathCharacters: 16_000_000,
  maxAppNameCharacters: 160,
});

const normalize = (value) =>
  String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .toLowerCase();
const exact = (paths, ...names) =>
  names.some((name) => paths.has(normalize(name)));
const matching = (files, expression) =>
  files.filter((file) => expression.test(file.normalizedPath));
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function safeAppName(value) {
  try {
    const name = String(value || "Dropped app");
    return name.length <= workspaceDiscoveryLimits.maxAppNameCharacters
      ? name
      : `${name.slice(0, workspaceDiscoveryLimits.maxAppNameCharacters - 1)}…`;
  } catch {
    return "Dropped app";
  }
}

function integrityReceipt({
  accepted,
  reason = null,
  inputFileCount = 0,
  firstRejectedIndex = null,
}) {
  return Object.freeze({
    accepted,
    reason,
    inputFileCount,
    acceptedFileCount: accepted ? inputFileCount : 0,
    rejectedFileCount: accepted ? 0 : inputFileCount,
    firstRejectedIndex,
  });
}

function invalidInspection(reason, inputFileCount, firstRejectedIndex = null) {
  return Object.freeze({
    accepted: false,
    files: Object.freeze([]),
    folderDepths: new Map(),
    integrity: integrityReceipt({
      accepted: false,
      reason,
      inputFileCount,
      firstRejectedIndex,
    }),
  });
}

function canonicalPath(path) {
  if (typeof path !== "string") return { reason: "invalid-file-record" };
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value) return { reason: "invalid-relative-path" };
  if (value.length > workspaceDiscoveryLimits.maxPathCharacters)
    return { reason: "path-length-limit-exceeded" };
  if (
    value.startsWith("/") ||
    /^[a-zA-Z]:($|\/)/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return { reason: "invalid-relative-path" };
  }
  const parts = value.split("/");
  if (
    parts.length > workspaceDiscoveryLimits.maxDepth + 1 ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes(".."),
    )
  ) {
    return {
      reason:
        parts.length > workspaceDiscoveryLimits.maxDepth + 1
          ? "path-depth-limit-exceeded"
          : "invalid-relative-path",
    };
  }
  if (
    parts.some(
      (part) => part.length > workspaceDiscoveryLimits.maxPathSegmentCharacters,
    )
  ) {
    return { reason: "path-segment-limit-exceeded" };
  }
  return { path: value, parts };
}

function inspectCensusFiles(census) {
  let sourceFiles;
  let inputFileCount;
  try {
    sourceFiles = Array.isArray(census?.files) ? census.files : [];
    inputFileCount = sourceFiles.length;
  } catch {
    return invalidInspection("invalid-census-files", 0);
  }
  if (inputFileCount > workspaceDiscoveryLimits.maxFiles) {
    return invalidInspection("file-count-limit-exceeded", inputFileCount);
  }
  try {
    if (
      census &&
      Object.hasOwn(census, "fileCount") &&
      census.fileCount !== inputFileCount
    ) {
      return invalidInspection("census-file-count-mismatch", inputFileCount);
    }
  } catch {
    return invalidInspection("invalid-census-files", inputFileCount);
  }

  const files = [];
  const exactPaths = new Set();
  const portablePaths = new Map();
  let totalPathCharacters = 0;
  for (let index = 0; index < inputFileCount; index += 1) {
    let source;
    let pathResult;
    try {
      source = sourceFiles[index];
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        return invalidInspection("invalid-file-record", inputFileCount, index);
      }
      pathResult = canonicalPath(source.path);
    } catch {
      return invalidInspection("invalid-file-record", inputFileCount, index);
    }
    if (pathResult.reason)
      return invalidInspection(pathResult.reason, inputFileCount, index);
    totalPathCharacters += pathResult.path.length;
    if (totalPathCharacters > workspaceDiscoveryLimits.maxTotalPathCharacters) {
      return invalidInspection(
        "path-character-budget-exceeded",
        inputFileCount,
        index,
      );
    }
    if (exactPaths.has(pathResult.path))
      return invalidInspection("duplicate-file-path", inputFileCount, index);
    const portableKey = pathResult.path.normalize("NFC").toLowerCase();
    if (portablePaths.has(portableKey))
      return invalidInspection("ambiguous-file-path", inputFileCount, index);
    exactPaths.add(pathResult.path);
    portablePaths.set(portableKey, pathResult.path);
    try {
      files.push(
        Object.freeze({
          path: pathResult.path,
          parts: Object.freeze(pathResult.parts),
          category:
            typeof source.category === "string"
              ? source.category.slice(0, 64)
              : "file",
          extension:
            typeof source.extension === "string"
              ? source.extension.slice(0, 32)
              : "",
        }),
      );
    } catch {
      return invalidInspection("invalid-file-record", inputFileCount, index);
    }
  }

  const folderDepths = new Map();
  const portableFolderPaths = new Map();
  const portableFilePaths = new Set(portablePaths.keys());
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    let parentPath = "";
    for (let partIndex = 0; partIndex < file.parts.length - 1; partIndex += 1) {
      parentPath = parentPath
        ? `${parentPath}/${file.parts[partIndex]}`
        : file.parts[partIndex];
      const portableParentPath = parentPath.normalize("NFC").toLowerCase();
      if (
        exactPaths.has(parentPath) ||
        portableFilePaths.has(portableParentPath)
      )
        return invalidInspection(
          "file-directory-collision",
          inputFileCount,
          fileIndex,
        );
      if (
        portableFolderPaths.has(portableParentPath) &&
        portableFolderPaths.get(portableParentPath) !== parentPath
      ) {
        return invalidInspection(
          "ambiguous-directory-path",
          inputFileCount,
          fileIndex,
        );
      }
      portableFolderPaths.set(portableParentPath, parentPath);
      if (!folderDepths.has(parentPath)) {
        folderDepths.set(parentPath, partIndex + 1);
        if (folderDepths.size > workspaceDiscoveryLimits.maxDirectories) {
          return invalidInspection(
            "directory-count-limit-exceeded",
            inputFileCount,
            fileIndex,
          );
        }
      }
    }
  }

  files.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({
    accepted: true,
    files: Object.freeze(files),
    folderDepths,
    integrity: integrityReceipt({ accepted: true, inputFileCount }),
  });
}

function safeSkippedCount(census) {
  try {
    return Array.isArray(census?.skipped) ? census.skipped.length : 0;
  } catch {
    return 0;
  }
}

function finding(id, label, certainty, evidence, detail) {
  return Object.freeze({
    id,
    label,
    certainty,
    evidence: Object.freeze(evidence.slice(0, 3)),
    evidenceCount: evidence.length,
    detail,
  });
}

function discoveryCategories(findings) {
  return Object.freeze(
    CATEGORY_DEFINITIONS.map((definition) =>
      Object.freeze({
        ...definition,
        findings: Object.freeze(findings.get(definition.id)),
        state: findings
          .get(definition.id)
          .some((item) => item.certainty === "observed")
          ? "observed"
          : findings.get(definition.id).length
            ? "signal"
            : "unanswered",
      }),
    ),
  );
}

export function buildWorkspaceDiscovery(
  census,
  { appName = "Dropped app" } = {},
) {
  const inspection = inspectCensusFiles(census);
  const files = inspection.files.map((file) => ({
    ...file,
    normalizedPath: normalize(file.path),
  }));
  const paths = new Set(files.map((file) => file.normalizedPath));
  const findings = new Map(
    CATEGORY_DEFINITIONS.map((category) => [category.id, []]),
  );
  const add = (categoryId, value) => findings.get(categoryId).push(value);

  if (inspection.accepted && files.length) {
    if (exact(paths, "package.json"))
      add(
        "A01",
        finding(
          "S001",
          "JavaScript or TypeScript app",
          "observed",
          ["package.json"],
          "A package manifest exists at the app root.",
        ),
      );
    if (exact(paths, "cargo.toml"))
      add(
        "A01",
        finding(
          "S002",
          "Rust workspace",
          "observed",
          ["Cargo.toml"],
          "A Rust manifest exists at the app root.",
        ),
      );
    if (files.some((file) => file.normalizedPath.startsWith(".git/")))
      add(
        "A01",
        finding(
          "S003",
          "Git metadata present",
          "observed",
          [".git/"],
          "Git is present, but remains optional to the Planner workflow.",
        ),
      );

    const vite = matching(files, /(^|\/)vite\.config\.[^/]+$/);
    const next = matching(files, /(^|\/)next\.config\.[^/]+$/);
    const tauri = matching(files, /(^|\/)src-tauri\/tauri\.conf\.json$/);
    const reactStyle = matching(files, /\.(jsx|tsx)$/);
    if (vite.length)
      add(
        "A02",
        finding(
          "S010",
          "Vite build configuration",
          "observed",
          vite.map((file) => file.path),
          "Configuration filename observed; package contents have not been read.",
        ),
      );
    if (next.length)
      add(
        "A02",
        finding(
          "S011",
          "Next.js configuration",
          "observed",
          next.map((file) => file.path),
          "Configuration filename observed; runtime behavior is not yet proven.",
        ),
      );
    if (tauri.length)
      add(
        "A02",
        finding(
          "S012",
          "Tauri desktop shell",
          "observed",
          tauri.map((file) => file.path),
          "A native Tauri configuration boundary is present.",
        ),
      );
    if (reactStyle.length)
      add(
        "A02",
        finding(
          "S013",
          "React-style component files",
          "signal",
          reactStyle.map((file) => file.path),
          `${reactStyle.length} JSX/TSX files suggest React-style UI; dependency confirmation still needs manifest review.`,
        ),
      );

    const frontend = matching(
      files,
      /(^|\/)(src\/)?(components|pages|app|views)\//,
    );
    const backend = matching(files, /(^|\/)(server|api|backend|functions)\//);
    const native = matching(files, /(^|\/)src-tauri\//);
    const workers = matching(files, /(^|\/)(worker|workers)\//);
    if (frontend.length)
      add(
        "A03",
        finding(
          "S020",
          "Frontend surface",
          "signal",
          frontend.map((file) => file.path),
          `${frontend.length} paths sit in common interface folders.`,
        ),
      );
    if (backend.length)
      add(
        "A03",
        finding(
          "S021",
          "Backend or API surface",
          "signal",
          backend.map((file) => file.path),
          `${backend.length} paths sit in common server folders.`,
        ),
      );
    if (native.length)
      add(
        "A03",
        finding(
          "S022",
          "Native application boundary",
          "observed",
          native.map((file) => file.path),
          `${native.length} files are inside src-tauri.`,
        ),
      );
    if (workers.length)
      add(
        "A03",
        finding(
          "S023",
          "Worker boundary",
          "signal",
          workers.map((file) => file.path),
          `${workers.length} files sit in worker-named folders.`,
        ),
      );

    const migrations = matching(files, /(^|\/)(migrations|prisma|supabase)\//);
    const auth = matching(files, /(^|\/)(auth|identity|permissions?)(\/|\.)/);
    const tenancy = matching(
      files,
      /(^|\/)(tenant|tenants|tenancy|multi-tenant|multitenant)(\/|\.|-)/,
    );
    if (migrations.length)
      add(
        "A04",
        finding(
          "S030",
          "Database or migration surface",
          "signal",
          migrations.map((file) => file.path),
          `${migrations.length} paths indicate schema or migration work.`,
        ),
      );
    if (auth.length)
      add(
        "A04",
        finding(
          "S031",
          "Authentication or permission surface",
          "signal",
          auth.map((file) => file.path),
          `${auth.length} paths contain identity-related names; enforcement is not yet proven.`,
        ),
      );
    if (tenancy.length)
      add(
        "A04",
        finding(
          "S032",
          "Multi-tenancy naming signal",
          "signal",
          tenancy.map((file) => file.path),
          "Tenant-named paths exist, but isolation still requires a contract and proof.",
        ),
      );

    const manifests = files.filter((file) =>
      /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|cargo\.lock|requirements\.txt|pyproject\.toml|go\.mod)$/.test(
        file.normalizedPath,
      ),
    );
    if (manifests.length)
      add(
        "A05",
        finding(
          "S040",
          "Dependency manifests",
          "observed",
          manifests.map((file) => file.path),
          `${manifests.length} dependency or lock files were indexed.`,
        ),
      );
    const integrations = matching(
      files,
      /(^|\/)(integrations?|adapters?|connectors?|providers?)\//,
    );
    if (integrations.length)
      add(
        "A05",
        finding(
          "S041",
          "Integration boundary",
          "signal",
          integrations.map((file) => file.path),
          `${integrations.length} files sit in integration-named folders.`,
        ),
      );

    const envFiles = matching(files, /(^|\/)\.env(\.|$)|\.env\.example$/);
    const security = matching(
      files,
      /(^|\/)(security|secrets?|vault|polic(y|ies)|capabilities)\//,
    );
    if (envFiles.length)
      add(
        "A06",
        finding(
          "S050",
          "Environment declarations",
          "observed",
          envFiles.map((file) => file.path),
          "Only filenames were indexed; values were not returned to the interface.",
        ),
      );
    if (security.length)
      add(
        "A06",
        finding(
          "S051",
          "Security policy surface",
          "signal",
          security.map((file) => file.path),
          `${security.length} security-named paths need contract review.`,
        ),
      );

    const tests = matching(
      files,
      /(^|\/)(__tests__|tests?|specs?)(\/|\.)|\.(test|spec)\.[^/]+$/,
    );
    const ci = matching(
      files,
      /(^|\/)\.github\/workflows\/|(^|\/)(gitlab-ci|azure-pipelines)\.(yml|yaml)$/,
    );
    const deploy = matching(
      files,
      /(^|\/)(dockerfile|wrangler\.toml|vercel\.json|netlify\.toml|fly\.toml|\.openai\/hosting\.json)$/,
    );
    if (tests.length)
      add(
        "A07",
        finding(
          "S060",
          "Test surface",
          "observed",
          tests.map((file) => file.path),
          `${tests.length} test-named files were indexed.`,
        ),
      );
    if (ci.length)
      add(
        "A07",
        finding(
          "S061",
          "CI configuration",
          "observed",
          ci.map((file) => file.path),
          `${ci.length} CI workflow files were indexed.`,
        ),
      );
    if (deploy.length)
      add(
        "A07",
        finding(
          "S062",
          "Deployment configuration",
          "observed",
          deploy.map((file) => file.path),
          `${deploy.length} deployment configuration files were indexed.`,
        ),
      );
  }

  const categories = discoveryCategories(findings);
  const allFindings = categories.flatMap((category) => category.findings);
  return Object.freeze({
    schemaVersion: 1,
    state: inspection.accepted
      ? files.length
        ? "discovering"
        : "empty"
      : "invalid",
    appName: safeAppName(appName),
    observedFiles: inspection.accepted ? files.length : 0,
    skippedFiles: safeSkippedCount(census),
    categories,
    counts: Object.freeze({
      observed: allFindings.filter((item) => item.certainty === "observed")
        .length,
      signals: allFindings.filter((item) => item.certainty === "signal").length,
      unanswered: categories.filter(
        (category) => category.state === "unanswered",
      ).length,
    }),
    integrity: inspection.integrity,
  });
}

function emptyRoot(appName) {
  return Object.freeze({
    id: "T000",
    kind: "root",
    name: safeAppName(appName),
    path: "",
    depth: 0,
    files: Object.freeze([]),
    children: Object.freeze([]),
  });
}

function invalidStructureTree(appName, integrity) {
  return Object.freeze({
    schemaVersion: 1,
    state: "invalid",
    root: emptyRoot(appName),
    directoryCount: 0,
    fileCount: 0,
    nodeCount: 1,
    integrity,
  });
}

export function buildWorkspaceStructureTree(
  census,
  { appName = "Dropped app" } = {},
) {
  const inspection = inspectCensusFiles(census);
  if (!inspection.accepted)
    return invalidStructureTree(appName, inspection.integrity);

  const root = {
    id: "T000",
    kind: "root",
    name: safeAppName(appName),
    path: "",
    depth: 0,
    files: [],
    children: [],
  };
  const directories = new Map([["", root]]);
  const orderedPaths = [...inspection.folderDepths.keys()].sort(compareText);

  for (let index = 0; index < orderedPaths.length; index += 1) {
    const path = orderedPaths[index];
    const separator = path.lastIndexOf("/");
    const parentPath = separator < 0 ? "" : path.slice(0, separator);
    const node = {
      id: `T${String(index + 1).padStart(3, "0")}`,
      kind: "folder",
      name: separator < 0 ? path : path.slice(separator + 1),
      path,
      depth: inspection.folderDepths.get(path),
      files: [],
      children: [],
    };
    directories.set(path, node);
    directories.get(parentPath).children.push(node);
  }

  for (const file of inspection.files) {
    const separator = file.path.lastIndexOf("/");
    const parentPath = separator < 0 ? "" : file.path.slice(0, separator);
    directories.get(parentPath).files.push(
      Object.freeze({
        name: separator < 0 ? file.path : file.path.slice(separator + 1),
        path: file.path,
        category: file.category,
        extension: file.extension,
      }),
    );
  }

  // Finalize children from the leaves upward. This deliberately avoids recursive
  // freezing so even a census at the configured depth ceiling cannot consume the
  // JavaScript call stack.
  const finalized = new Map();
  const bottomUp = [...directories.values()].sort(
    (left, right) =>
      right.depth - left.depth || compareText(right.path, left.path),
  );
  for (const node of bottomUp) {
    const children = node.children
      .slice()
      .sort(
        (left, right) =>
          compareText(left.name, right.name) ||
          compareText(left.path, right.path),
      )
      .map((child) => finalized.get(child.path));
    const files = node.files
      .slice()
      .sort((left, right) => compareText(left.path, right.path));
    finalized.set(
      node.path,
      Object.freeze({
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.path,
        depth: node.depth,
        files: Object.freeze(files),
        children: Object.freeze(children),
      }),
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    state: inspection.files.length ? "ready" : "empty",
    root: finalized.get(""),
    directoryCount: orderedPaths.length,
    fileCount: inspection.files.length,
    nodeCount: orderedPaths.length + 1,
    integrity: inspection.integrity,
  });
}

export const workspaceDiscoveryCategories = CATEGORY_DEFINITIONS;
