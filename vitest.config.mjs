import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { mermaidDocuments } from "./vite.config.mjs";

export default defineConfig({
  plugins: [mermaidDocuments(), react()],
  test: { environment: "jsdom", include: ["tests-ui/**/*.test.jsx"], restoreMocks: true },
});
