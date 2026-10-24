import { describe, expect, it } from "vitest";
import { containmentView } from "./routes/tasks";

describe("containmentView (what the Tasks screen tells the person)", () => {
  it("is not contained unless the person opted in", async () => {
    expect(await containmentView({}, "linux")).toEqual({ contained: false });
    expect(await containmentView({ PP_CONTAIN_TESTS: "0" }, "linux")).toEqual({ contained: false });
  });
  it("is never contained on Windows or macOS, even opted in", async () => {
    expect(await containmentView({ PP_CONTAIN_TESTS: "1" }, "win32")).toEqual({ contained: false });
    expect(await containmentView({ PP_CONTAIN_TESTS: "1" }, "darwin")).toEqual({ contained: false });
  });
  it.skipIf(process.platform !== "linux")("on Linux, opted in, follows whether bubblewrap really works here", async () => {
    const view = await containmentView({ ...process.env, PP_CONTAIN_TESTS: "1" }, "linux");
    expect(view.contained).toBe(view.by === "bubblewrap");
  });
});
