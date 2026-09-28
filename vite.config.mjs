import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCollisionAuthorityMiddleware } from "./src/node/collisionAuthorityHttp.mjs";
import { createFolderContractMiddleware } from "./src/node/folderContractHttp.mjs";
import { createArchitectureContractMiddleware } from "./src/node/architectureContractStore.mjs";
import { createComponentPlanMiddleware } from "./src/node/componentPlanHttp.mjs";
import { createPlanningLedgerMiddleware } from "./src/node/planningLedgerHttp.mjs";
import { initializePlanningLedgerHostRoot } from "./src/node/planningLedgerHostRoot.mjs";
import { taskObservationVitePlugin } from './src/node/taskObservationVitePlugin.mjs';

const collisionAuthority = () => ({ name: "perfect-planner-collision-authority", configureServer(server) { server.middlewares.use(createCollisionAuthorityMiddleware({ root: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority") })); } });
const folderContracts = () => ({ name: "perfect-planner-folder-contracts", configureServer(server) { server.middlewares.use(createFolderContractMiddleware({ root: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority") })); } });
const architectureContracts = () => ({ name: "perfect-planner-architecture-contracts", configureServer(server) { server.middlewares.use(createArchitectureContractMiddleware({ root: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority") })); } });
const componentPlans = () => ({ name: "perfect-planner-component-plans", configureServer(server) { server.middlewares.use(createComponentPlanMiddleware({ root: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority") })); } });
const planningLedger = () => ({ name: "perfect-planner-planning-ledger", async configureServer(server) { const root = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority"); await initializePlanningLedgerHostRoot(root); server.middlewares.use(createPlanningLedgerMiddleware({ root })); } });

// The atlas displays the first diagram, not the surrounding authoring notes.
// Extract at build time so development and packaged clients render identical text.
export const mermaidDocuments = () => ({
  name: "perfect-planner-mermaid-documents",
  load(id) {
    if (!id.endsWith(".md?mermaid")) return null;
    const file = id.slice(0, -"?mermaid".length);
    this.addWatchFile(file);
    const source = readFileSync(file, "utf8");
    const diagram = source.match(/```mermaid\s*([\s\S]*?)```/)?.[1]?.trim() ?? "No Mermaid block found.";
    return `export default ${JSON.stringify(diagram)};`;
  },
});

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep reusable framework code cacheable across application changes.
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id.replaceAll("\\", "/"))) return "framework";
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  plugins: [mermaidDocuments(), collisionAuthority(), architectureContracts(), folderContracts(), componentPlans(), planningLedger(), taskObservationVitePlugin(), react()],
});
