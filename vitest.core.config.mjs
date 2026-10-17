import { defineConfig } from "vitest/config";

// Core loop modules (core/<module>/): plain Node, no DOM, no React plugin.
// Windows runners are slow at process spawning and file scanning: with every core file in parallel,
// host tests that take 6 s alone took 20-50 s and hit the 20 s limit on PRs that never touched them.
// Fewer workers and a longer limit keep them honest; a hung test still fails, just later.
const windows = process.platform === "win32";
export default defineConfig({
  test: { environment: "node", include: ["core/**/*.test.ts"], restoreMocks: true, testTimeout: windows ? 60000 : 20000, ...(windows ? { maxWorkers: 2 } : {}) },
});
