import { defineConfig } from "vitest/config";

// Core loop modules (core/<module>/): plain Node, no DOM, no React plugin.
export default defineConfig({
  test: { environment: "node", include: ["core/**/*.test.ts"], restoreMocks: true, testTimeout: 20000 },
});
