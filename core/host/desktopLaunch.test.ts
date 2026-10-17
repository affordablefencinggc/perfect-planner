// The desktop shell's launch secret: the starter gives the same value to the host (env) and the
// shell, which hands it to its window over IPC. The host takes it once and it claims only once.
import { afterEach, beforeEach, expect, it } from "vitest";
import { claimLaunch, hostCall, startTestHost } from "./testing";

let ctx: Awaited<ReturnType<typeof startTestHost>>;
beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => ctx.stop());

it("accepts the desktop secret from the environment once, removes it, and lets it be claimed once", async () => {
  const secret = "d".repeat(43);
  const env: NodeJS.ProcessEnv = { PP_CORE_DESKTOP_LAUNCH: secret };
  expect(ctx.host.acceptDesktopLaunch(env)).toBe(true);
  expect(env.PP_CORE_DESKTOP_LAUNCH).toBeUndefined();
  expect(ctx.host.acceptDesktopLaunch(env)).toBe(false);
  const first = await claimLaunch(ctx.base, secret);
  expect(first.status).toBe(200);
  expect(first.csrf).toBeTruthy();
  expect((await claimLaunch(ctx.base, secret)).status).toBe(401);
});

it("ignores a malformed secret", () => {
  expect(ctx.host.acceptDesktopLaunch({ PP_CORE_DESKTOP_LAUNCH: "short" })).toBe(false);
  expect(ctx.host.acceptDesktopLaunch({ PP_CORE_DESKTOP_LAUNCH: "x".repeat(30) + "#" })).toBe(false);
});

it("gives the person's own window a one-time link for another window, and nobody else", async () => {
  expect((await hostCall(ctx.base, "POST", "/session/new-window", {}, { asAgent: true })).status).toBe(401);
  expect((await hostCall(ctx.base, "GET", "/session/new-window")).status).toBe(405);
  const res = await hostCall(ctx.base, "POST", "/session/new-window", {});
  expect(res.status).toBe(200);
  const launch = res.body.result.launch as string;
  expect(launch).toMatch(/^[\w-]{20,128}$/);
  expect((await claimLaunch(ctx.base, launch)).status).toBe(200);
  expect((await claimLaunch(ctx.base, launch)).status).toBe(401);
});
