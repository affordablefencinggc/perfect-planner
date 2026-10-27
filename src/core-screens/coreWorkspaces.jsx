import { lazy, Suspense } from "react";
// Loaded with the app (JS only, no stylesheet) so a one-time launch link is claimed and
// taken out of the address bar as soon as the window opens, whichever screen is shown.
import "./coreApi.js";

// The core loop screens and where they sit in the stage navigation
// (Define: planning, mvp · Build: tasks · Coordinate: decisions, people · Release: lookup).
const screens = {
  planning: lazy(() => import("./DeepPlanningScreen.jsx")),
  mvp: lazy(() => import("./MvpBoardScreen.jsx")),
  decisions: lazy(() => import("./DecisionsScreen.jsx")),
  people: lazy(() => import("./PeopleScreen.jsx")),
  share: lazy(() => import("./ShareScreen.jsx")),
  tasks: lazy(() => import("./TasksScreen.jsx")),
  lookup: lazy(() => import("./LedgerLookupScreen.jsx")),
};

export const CORE_WORKSPACES = Object.freeze(Object.keys(screens));

export const coreWorkspaceLabels = {
  planning: "Deep planning",
  mvp: "MVP board",
  decisions: "Decisions",
  people: "People",
  share: "Share",
  tasks: "Tasks",
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
  share: {
    stage: "coordinate",
    purpose: "Send work to a teammate as a file and receive theirs, privately, with no GitHub.",
    outcome: "Received work is checked and shown with any files that clash before anything merges.",
    unlock: "Make a file to send, or put one you received in the inbox.",
  },
  tasks: {
    stage: "build",
    purpose: "Start a worker on each task, approve its test, check the work, approve the diff and merge.",
    outcome: "Every task merged with its approved test passing on the merge.",
    unlock: "Start a worker on the next task.",
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
    <Suspense fallback={<ScreenLoading label={`Loading ${coreWorkspaceLabels[workspace]}`} />}>
      <Screen onWorkspace={onWorkspace} />
    </Suspense>
  );
}

// While a screen's code loads. Kept free of CoreScreen.jsx so the core screens' stylesheet
// stays out of the first-load bundle (scripts/verify-performance-budget.mjs).
function ScreenLoading({ label }) {
  return <p className="core-loading" role="status" aria-live="polite" aria-label={label}>{label}…</p>;
}
