// INDEX-BUILD: the project index is computed on demand from current records, so
// it exists whenever the project has a folder scan to bind it to.
// BUILD-RUN: recorded once every approved task has been marked Done on the Build board.
import { buildRunProgress } from "../projectBuildModel.js";

export const receiptDerivers = Object.freeze({
  "INDEX-BUILD": (_sections, { project } = {}) => {
    const census = project?.census;
    if (!census) return null;
    return { state: "recorded", detail: `Built on demand from this project's saved records and its folder scan of ${census.fileCount.toLocaleString()} files.` };
  },
  "BUILD-RUN": (sections) => {
    const progress = buildRunProgress(sections);
    if (!progress) return null;
    if (progress.approvalChanged) return { state: "stale", detail: "The approved plan changed after build progress was saved. Review the Build board." };
    const summary = `${progress.done} of ${progress.total} approved task${progress.total === 1 ? "" : "s"} marked done${progress.blocked ? ` · ${progress.blocked} blocked` : ""}`;
    return { state: progress.done === progress.total ? "recorded" : "review", detail: summary };
  },
});
