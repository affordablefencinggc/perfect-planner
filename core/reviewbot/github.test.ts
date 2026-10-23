import { describe, expect, it } from "vitest";
import { Github } from "./github";
import { markedHead } from "./render";
import { reviewPullRequest } from "./rules";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function fake(existing: any[] = []) {
  const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
  const f = (async (url: string, init: any) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method;
    calls.push({ method, path, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (path.includes("/pulls/5/files")) return ok([{ filename: "docs/a.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+hi" }]);
    if (path.includes("/pulls/5/commits")) return ok([{ commit: { author: { email: "1+x@users.noreply.github.com" } } }]);
    if (path.includes("/pulls/5")) return ok({ head: { sha: HEAD }, base: { sha: BASE }, draft: true, body: "", mergeable: true });
    if (path.includes("/check-runs")) return ok({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "review-bot", status: "completed", conclusion: "failure" }] });
    if (path.includes("/issues/5/comments") && method === "GET") return ok(existing);
    return ok({});
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("github poster", () => {
  it("reads facts, ignores its own status, creates a comment then edits the same one", async () => {
    const a = fake();
    const gh = new Github({ fetch: a.f, token: "t0k", repo: "o/r" });
    const review = reviewPullRequest(await gh.facts(5));
    expect(review).toMatchObject({ headSha: HEAD, baseSha: BASE });
    expect(review.verdict).toBe("GO");
    expect(await gh.post(review)).toBe("created");
    expect(a.calls.find((c) => c.method === "POST" && c.path.endsWith("/statuses/" + HEAD))?.body).toMatchObject({ state: "success", context: "review-bot" });
    const body = a.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues/5/comments"))!.body.body;
    expect(markedHead(body)).toBe(HEAD);

    const b = fake([{ id: 9, user: { login: "github-actions[bot]" }, body: "<!-- review-bot head=" + "e".repeat(40) + " verdict=GO -->\nold" }]);
    expect(await new Github({ fetch: b.f, token: "t0k", repo: "o/r" }).post(review)).toBe("updated");
    expect(b.calls.some((c) => c.method === "PATCH" && c.path.endsWith("/comments/9"))).toBe(true);
    expect(b.calls.some((c) => c.method === "POST" && c.path.endsWith("/issues/5/comments"))).toBe(false);
  });

  it("attack: a marker copied by someone else is never edited", async () => {
    const f = fake([{ id: 3, user: { login: "mallory" }, body: "<!-- review-bot head=" + "e".repeat(40) + " verdict=GO -->" }]);
    const gh = new Github({ fetch: f.f, token: "t0k", repo: "o/r" });
    expect(await gh.post(reviewPullRequest(await gh.facts(5)))).toBe("created");
    expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("repeating the same review does not edit the comment again", async () => {
    const f = fake();
    const gh = new Github({ fetch: f.f, token: "t0k", repo: "o/r" });
    const review = reviewPullRequest(await gh.facts(5));
    await gh.post(review);
    const body = f.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues/5/comments"))!.body.body;
    const g = fake([{ id: 1, user: { login: "github-actions[bot]" }, body }]);
    await new Github({ fetch: g.f, token: "t0k", repo: "o/r" }).post(review);
    expect(g.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("rejects a bad repo name and never puts the token in an error", async () => {
    expect(() => new Github({ fetch, token: "t", repo: "../etc" })).toThrow();
    const bad = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const tok = "q".repeat(20);
    const err = await new Github({ fetch: bad, token: tok, repo: "o/r" }).facts(5).catch((e) => String(e));
    expect(err).toContain("403");
    expect(err).not.toContain(tok);
  });
});
