import React from "react";
import { createRoot } from "react-dom/client";
import { PerfectPlannerShell } from "./PerfectPlannerShell.jsx";
import { ProjectProvider } from "./project/ProjectProvider.jsx";
import "./styles.css";

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

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ProjectProvider>
      <PerfectPlannerShell />
    </ProjectProvider>
    <LocalAgentation />
  </React.StrictMode>,
);
