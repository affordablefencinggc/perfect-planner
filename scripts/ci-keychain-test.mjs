#!/usr/bin/env node
// CI step: the ledger's signing keys against the real OS keychain (Credential Locker,
// the macOS keychain, the Secret Service). One node command, so the CI plan the app
// derives from core-ci.yml stays reproducible without shell semantics. On Linux in CI
// it installs secret-tool and runs the test inside a private unlocked gnome-keyring.
import { spawnSync } from "node:child_process";

const env = { ...process.env, PP_KEYCHAIN_TEST: "1", PP_KEYCHAIN_REQUIRED: "1" };
const vitest = ["vitest", "run", "-c", "vitest.core.config.mjs", "core/ledger/keychain.test.ts", "--reporter=verbose"];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" && command === "npx", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.platform === "linux") {
  if (process.env.CI !== "true") {
    console.error("The Linux keychain step installs packages and starts a private keyring; it only runs in CI (CI=true).");
    process.exit(1);
  }
  run("sudo", ["apt-get", "update", "-qq"]);
  run("sudo", ["apt-get", "install", "-y", "-qq", "libsecret-tools", "gnome-keyring", "dbus"]);
  run("dbus-run-session", ["--", "sh", "-c", `printf "ci-only-password" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && npx ${vitest.join(" ")}`]);
} else {
  run("npx", vitest);
}
