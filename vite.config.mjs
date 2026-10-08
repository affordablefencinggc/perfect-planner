import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { localAuthorityVitePlugin } from "./src/node/localAuthorityHost.mjs";
import { defaultRegistryRoot, mcpServerPath } from "./mcp/agentSetupPaths.mjs";

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

// "Connect agent" snippets need this checkout's absolute MCP server path. Embed it only for the
// local dev server; shipped builds keep a placeholder unless PP_MCP_SERVER_PATH is set explicitly.
const agentSetupDefines = (command) => {
  const local = command === "serve";
  const serverPath = process.env.PP_MCP_SERVER_PATH ?? (local ? mcpServerPath() : "");
  const registryRoot = process.env.PP_MCP_REGISTRY_ROOT ?? (local ? defaultRegistryRoot() ?? "" : "");
  return { "import.meta.env.VITE_PP_MCP_SERVER_PATH": JSON.stringify(serverPath), "import.meta.env.VITE_PP_MCP_REGISTRY_ROOT": JSON.stringify(registryRoot) };
};

export default defineConfig(({ command }) => ({
  define: agentSetupDefines(command),
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
    // Loopback only by default. PP_DEV_HOST (e.g. 0.0.0.0) opts in to exposure; authority
    // APIs still refuse non-loopback peers and Host headers. PP_DEV_ALLOWED_HOSTS is comma-separated.
    host: process.env.PP_DEV_HOST || "127.0.0.1",
    allowedHosts: (process.env.PP_DEV_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Local saving APIs (shared with scripts/serve-local.mjs for production use).
  plugins: [mermaidDocuments(), localAuthorityVitePlugin(), react()],
}));
