// Release-only: prints the draft release body (stamp, downloads, checksums) to stdout.
//   node scripts/release/release-notes.mjs --release R-2 --dir release-out > notes.md
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
const release = args.release || "dry-run";
const dir = path.resolve(root, args.dir || "release-out");
const version = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const commit = process.env.GITHUB_SHA || "local";
const files = readdirSync(dir).sort();
const sums = files.filter((f) => f.startsWith("SHA256SUMS-")).map((f) => readFileSync(path.join(dir, f), "utf8").trim()).join("\n");
const pick = (suffix) => files.filter((f) => f.endsWith(suffix)).map((f) => `\`${f}\``).join(", ") || "not built";

process.stdout.write(`## Perfect Planner ${release}

| Stamp | Value |
|---|---|
| Release | ${release} |
| Version | ${version} |
| Commit | ${commit} |

### Which file do I download?

| Computer | File |
|---|---|
| Windows (recommended) | ${pick(".setup.exe")} |
| Windows (IT / managed installs) | ${pick(".msi")} |
| Linux (Ubuntu, Debian) | ${pick(".deb")} |
| Linux (Fedora, RHEL) | ${pick(".rpm")} |
| Linux (any, portable) | ${pick(".AppImage")} |

There is no macOS build. These builds are **not code-signed** yet. Windows SmartScreen may say "Windows protected your PC": choose **More info**, then **Run anyway**. Connecting a coding agent currently works on Windows only; on Linux the planner itself runs, and agent connection reports that the platform is not supported yet.

### SHA-256

\`\`\`
${sums}
\`\`\`
`);
