# Privacy

Perfect Planner runs on your computer. This page says what leaves it.

## What leaves your computer

One thing, and only if you choose it.

- When you save a TypeSafe key in Settings, the app can ask TypeSafe's Jev to review your work.
- For a review, the test and diff text is sent to `https://api.typesafe.ai/v1/systemone`, using your key.
- Without a saved key, nothing is sent. The review shows as unavailable. It is never treated as an approval.

Nothing else is sent by the app.

- GitHub is used only by your own `git`, with your own settings. The app does not talk to GitHub itself.
- Your agent (Claude Code, Codex or Gemini) talks to its own service under its own terms. That is outside this app.

## Where your data lives

- Projects, the ledger and your settings live in the app data folder on your computer.
- On Windows that is `%APPDATA%\com.perfectplanner.desktop`. On Linux it is `~/.local/share/com.perfectplanner.desktop`.
- Your signing key and TypeSafe key are kept in your computer's key store (Windows Credential Manager, or the Linux Secret Service).
- Uninstalling the app keeps this data. Delete the folder yourself if you want it gone.

## No telemetry

The app has no analytics, crash reporting or usage tracking. It does not check for updates.

We checked this by searching `src/`, `core/` and `src-tauri/` for `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, analytics or tracking names, and every `http(s)://` address. We found:

- The app's own screens call only the app's local host on `127.0.0.1`.
- The only live outbound address wired into the app is the TypeSafe one above.
- `core/planning/research.ts` has code for Perplexity and Firecrawl searches. Nothing in the app creates those providers, so they are never called.
- `core/reviewbot/github.ts` and `core/release/pushProtection.ts` hold GitHub API addresses for repo tooling. The app does not use them.
- The other matches are tests, local test servers, and links in code comments.

This was checked on `main` at commit bff36fa. If that changes, this page changes with it.
