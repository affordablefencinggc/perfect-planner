import { createStableProjectId } from "../project/projectIds.js";
import { createProjectSession } from "../project/projectSession.js";

export const DEMO_PROJECT_ID = createStableProjectId("perfect-planner-demo", "perfect-planner:explicit-demo:v1");

export const demoProjectDescriptor = Object.freeze({
  projectId: DEMO_PROJECT_ID,
  name: "Perfect Planner Demo",
  disclosure: "Demonstration fixtures only. Nothing on this project is evidence about an imported app.",
  fixtureNamespace: "demo:perfect-planner:v1",
});

export function createDemoProjectSession({ now = Date.now() } = {}) {
  return createProjectSession({
    projectId: DEMO_PROJECT_ID,
    name: demoProjectDescriptor.name,
    kind: "demo",
    state: "demo",
    now,
  });
}

export function isDemoProject(project) {
  return Boolean(project && project.projectId === DEMO_PROJECT_ID && project.kind === "demo" && project.state === "demo");
}

