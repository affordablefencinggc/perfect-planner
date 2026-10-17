# Perfect Planner

A structured planning app: point it at a project folder, get a reviewed plan, and let coding agents read that plan.

## Quick start

1. **Install.** Download the installer for your computer from the [latest release](https://github.com/affordablefencinggc/perfect-planner/releases):

   | Computer | File |
   |---|---|
   | Windows | `PerfectPlanner-…-windows-x64.setup.exe` (or `.msi` for managed installs) |
   | Linux | `.deb`, `.rpm` or `.AppImage` |

   Builds are not code-signed yet. On Windows, if SmartScreen appears, choose **More info**, then **Run anyway**.

2. **Open the app.** Start **Perfect Planner** from the Start menu or your launcher.

3. **Choose a folder.** Click **Add project**, then choose your project's folder. Nothing is read until you approve the analysis, and nothing in the folder is changed.

4. **Connect an agent** (Windows). Click **Connect agent** in the header, copy the entry it shows into your IDE's MCP settings, and reload your agent's tools. The agent server runs from a copy of this repository: clone it, run `npm install` once (Node.js 18 or newer), and point the entry at that folder. Agents can read your plan and propose tasks; proposals come back to you for review.

## Run from source

```sh
npm install
npm start          # web app at http://127.0.0.1:4173
npm run tauri:dev  # desktop app (needs Rust)
```

## Making a release

Push a tag named `R-<number>` (for example `git tag R-2 && git push origin R-2`). The **Perfect Planner Release** workflow builds the Windows and Linux installers and attaches them to a **draft** release with the release stamp, version and commit in each file name. Review the draft on GitHub and publish it yourself.

**One-time setup (recommended):** the step that creates the draft runs in a GitHub environment named `release`. To make sure only you can trigger it, open the repository on GitHub, go to **Settings → Environments → release** (it appears after the first tag build; or click **New environment** and name it `release`), tick **Required reviewers** and add yourself, then under **Deployment branches and tags** choose **Selected branches and tags** and add a tag rule `R-*`. Each release then waits for your **Approve** click on the workflow run before the draft is made.

For a test build without a release, push to a `release/…` branch (or run the workflow by hand from the Actions tab with the stamp left as `dry-run`); the installers appear as downloadable workflow artifacts on that run.
