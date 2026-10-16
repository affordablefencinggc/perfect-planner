// Testing Library's findBy*/waitFor give up after 1 s by default. Lazily loaded workspaces and
// drawers can take longer than that on a loaded CI runner (Windows especially), which failed
// tests on PRs that never touched the UI. Waits still end the moment the element appears.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5000 });
