# Known issues

Things that do not work yet, or work with limits. We would rather tell you now.

## Safety

- **Tests run with your full rights.** An approved test command runs as you. It can read your files and use your network. Only Linux has an opt-in sandbox (set `PP_CONTAIN_TESTS=1`; needs bubblewrap). Windows has none. Read a command before you approve it.
- **Your key store has limits.** On Linux, any program running as you can read your signing key with `secret-tool`. On Windows, Credential Manager has no per-app lock. Keep your computer's account private.

## Install and update

- **Windows installers are not signed.** SmartScreen may warn. Choose **More info**, then **Run anyway**.
- **macOS is not supported.** Windows and Linux only.
- **Updating means reinstalling.** There is no auto-updater. Download the new installer and run it. Your data is kept.
- **Uninstalling keeps your data.** Projects and the ledger stay in the app data folder. Delete it yourself to remove them. See [PRIVACY.md](PRIVACY.md).

## Using the app

- **The app stops at the local merge.** It does not push, open a pull request or run CI. Do that with your own git.
- **Open project folder has limits.** Linux has no folder picker, so type or paste the path. The Windows picker is not fully tested.
- **Gemini and Codex agents are beta.** Claude Code is the supported agent. Gemini needs "Trust folder" set before you paste the connect line. Codex allows one connection per computer, and Start only launches Claude Code.

## About this repository

- **The public commit history contains the owner's personal email address and four profile photos.** None are in the current files. We chose not to rewrite history, so they remain in older commits. No secret or key is exposed.
