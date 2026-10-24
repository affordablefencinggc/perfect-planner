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

4. **Connect an agent.** Click **Connect agent** in the header, then **Connect agent** on the card, and paste the one line it shows into a terminal in the folder your agent will work in (on Windows, PowerShell). It registers the agent with Claude Code and installs the Perfect Planner skill; then it starts Claude Code there and tells it to check in, so you type nothing more (add `--no-start` to the line to only connect). Pasted into an agent's chat instead, you say *check in with Perfect Planner* yourself. The app ships its own Node runtime for this, so there is nothing else to install. For other agents, copy the MCP settings it shows instead.

## Supported computers

Windows and Linux only. macOS is not supported and the app is not notarized, so no macOS build is offered.

## Supported agents

Claude Code is supported. Gemini CLI and Codex CLI are beta, each with one known limitation:

- **Gemini CLI:** choose **Trust folder** before pasting the connect line. Its headless shell may be denied.
- **Codex CLI:** only one connection per computer; connecting again replaces the earlier one.

## What it does not do yet

- It does not push to a remote.
- It does not open pull requests.
- It does not run CI.
- It does not make a release from the app.
- It stops at the local merge; everything after that you do yourself in git or GitHub.

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
