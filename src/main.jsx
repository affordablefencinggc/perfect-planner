import React from "react";
import { createRoot } from "react-dom/client";
import { PerfectPlannerShell } from "./PerfectPlannerShell.jsx";
import { ProjectProvider } from "./project/ProjectProvider.jsx";
import { createMemoryStorage, DEFAULT_PROJECT_REGISTRY_KEY } from "./project/projectRegistry.js";
import { AppErrorBoundary, isSafeStart, SafeStartNotice } from "./components/AppErrorBoundary.jsx";
import { RegistryHealthNotice } from "./components/RegistryHealthNotice.jsx";
import "./styles.css";
import "./styles/frame.css";
import "./styles/polish/define.css";
import "./styles/polish/plan.css";
import "./styles/polish/collision-allocation.css";
import "./styles/polish/build.css";
import "./styles/polish/prove.css";
import "./styles/polish/release-index.css";
import "./styles/polish/structure.css";

function LocalAgentation() {
  const [Toolbar, setToolbar] = React.useState(null);

  React.useEffect(() => {
    // Loopback is also a release/native origin, not permission to load developer tools.
    if (!import.meta.env.DEV) return undefined;
    let active = true;
    import("agentation").then(({ Agentation }) => {
      if (active) setToolbar(() => Agentation);
    }).catch(() => {
      // Optional development feedback must not become an unhandled app failure.
      console.warn("Development feedback toolbar could not be loaded.");
    });
    return () => { active = false; };
  }, []);

  return Toolbar ? <Toolbar /> : null;
}

// Safe start keeps saved projects untouched: an in-memory registry under a separate key ignores other tabs' storage events.
const safeStart = isSafeStart();
const registryProps = safeStart ? { storage: createMemoryStorage(), storageKey: `${DEFAULT_PROJECT_REGISTRY_KEY}.safe-start` } : {};

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary safeStart={safeStart}>
      {safeStart ? <SafeStartNotice /> : null}
      <ProjectProvider {...registryProps}>
        <RegistryHealthNotice />
        <PerfectPlannerShell />
      </ProjectProvider>
    </AppErrorBoundary>
    <LocalAgentation />
  </React.StrictMode>,
);
