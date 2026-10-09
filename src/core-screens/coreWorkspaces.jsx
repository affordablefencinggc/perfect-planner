import { lazy, Suspense } from "react";
import { CoreLoading } from "./CoreScreen.jsx";

// The core loop screens and where they sit in the stage navigation
// (Define: planning, mvp · Coordinate: decisions, people · Release: lookup).
const screens = {
  planning: lazy(() => import("./DeepPlanningScreen.jsx")),
  mvp: lazy(() => import("./MvpBoardScreen.jsx")),
  decisions: lazy(() => import("./DecisionsScreen.jsx")),
  people: lazy(() => import("./PeopleScreen.jsx")),
  lookup: lazy(() => import("./LedgerLookupScreen.jsx")),
};

export const CORE_WORKSPACES = Object.freeze(Object.keys(screens));

export const coreWorkspaceLabels = {
  planning: "Deep planning",
  mvp: "MVP board",
  decisions: "Decisions",
  people: "People",
  lookup: "Ledger search",
};

export const coreWorkspaceContext = {
  planning: {
    stage: "define",
    purpose: "Answer the hard questions (stack, data, auth, hosting) before any code.",
    outcome: "Every blocking question answered, with a mind map and a roadmap.",
    unlock: "Answer the open blocking questions.",
  },
  mvp: {
    stage: "define",
    purpose: "See what is Done, Partial or Missing, with evidence, and draw the MVP line.",
    outcome: "One confirmed MVP line that every later stage builds toward.",
    unlock: "Confirm or move the proposed MVP line.",
  },
  decisions: {
    stage: "coordinate",
    purpose: "Jev's recommendations, with reasons, confidence, model and cost.",
    outcome: "Each open decision accepted or overridden, on the ledger.",
    unlock: "Decide the open cards.",
  },
  people: {
    stage: "coordinate",
    purpose: "Who is on this project, where each person is, and the documents you share.",
    outcome: "Helpers added with the right role; shared docs versioned.",
    unlock: "Add a helper or share a document.",
  },
  lookup: {
    stage: "release",
    purpose: "Find any ledger entry, clause or release by its number.",
    outcome: "Every number resolves to who, what, why and evidence.",
    unlock: "Search for P-12 §3.2, R-5, T-14 or L-000231.",
  },
};

export const isCoreWorkspace = (workspace) => Object.hasOwn(screens, workspace);

export function CoreWorkspace({ workspace, onWorkspace }) {
  const Screen = screens[workspace];
  if (!Screen) return null;
  return (
    <Suspense fallback={<CoreLoading label={`Loading ${coreWorkspaceLabels[workspace]}`} />}>
      <Screen onWorkspace={onWorkspace} />
    </Suspense>
  );
}
