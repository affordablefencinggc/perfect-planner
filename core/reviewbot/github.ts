import { markedHead, renderReview, statusText } from "./render";
import type { Budgets, ChangedFile, PrFacts, Review, Sizes } from "./rules";

// The only code that talks to GitHub. `fetch` is injected so tests use a fake.
// It reads PR facts through the API; it never checks out or runs the PR's code.

export interface GithubOptions {
  fetch: typeof fetch;
  /** Empty for read-only runs against a public repo. */
  token: string;
  repo: string; // owner/name
  /** Login the bot's own comments are written as; other people's comments are never edited. */
  botLogin?: string;
  apiBase?: string;
}

const NAME = /^(?!\.+\/)(?!.*\/\.+$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class Github {
  private readonly base: string;
  private readonly botLogin: string;
  constructor(private readonly o: GithubOptions) {
    if (!NAME.test(o.repo)) throw new Error("repo must look like owner/name");
    this.base = (o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.botLogin = o.botLogin ?? "github-actions[bot]";
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.o.fetch(`${this.base}${path}`, {
      method,
      headers: { ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path.replace(/\?.*/, "")} failed with ${res.status}`); // never echo headers or the token
    return res.status === 204 ? null : res.json();
  }

  private async all(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 30; page++) {
      const chunk = await this.call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = Array.isArray(chunk) ? chunk : (chunk.check_runs ?? chunk.statuses ?? []);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async facts(number: number, extra: { sizes?: Sizes; budgets?: Budgets; expectedGreen?: number } = {}): Promise<PrFacts> {
    const r = this.o.repo;
    const pr = await this.call("GET", `/repos/${r}/pulls/${number}`);
    const files = (await this.all(`/repos/${r}/pulls/${number}/files`)).map(
      (f): ChangedFile => ({ path: f.filename, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}), status: f.status, additions: f.additions, deletions: f.deletions, ...(typeof f.patch === "string" ? { patch: f.patch } : {}) }),
    );
    const commits = await this.all(`/repos/${r}/pulls/${number}/commits`);
    const runs = await this.all(`/repos/${r}/commits/${pr.head.sha}/check-runs`);
    const checks = runs
      .filter((c) => c.name !== "review-bot")
      .map((c) => ({ name: String(c.name), conclusion: (c.status !== "completed" ? "pending" : ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(c.conclusion) ? "failure" : c.conclusion === "success" ? "success" : c.conclusion === "skipped" ? "skipped" : "neutral") as PrFacts["checks"][number]["conclusion"] }));
    return {
      number,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      draft: Boolean(pr.draft),
      body: pr.body ?? "",
      files,
      authorEmails: commits.map((c) => c.commit?.author?.email).filter((e): e is string => typeof e === "string"),
      checks,
      mergeable: pr.mergeable ?? null,
      ...extra,
    };
  }

  /** Creates the bot's comment, or edits its existing one in place. Returns "created" or "updated". */
  async post(review: Review): Promise<"created" | "updated"> {
    const r = this.o.repo;
    const body = renderReview(review);
    const comments = await this.all(`/repos/${r}/issues/${review.number}/comments`);
    const mine = comments.find((c) => c.user?.login === this.botLogin && markedHead(String(c.body)) !== null);
    let how: "created" | "updated";
    if (mine) {
      if (mine.body !== body) await this.call("PATCH", `/repos/${r}/issues/comments/${mine.id}`, { body });
      how = "updated";
    } else {
      await this.call("POST", `/repos/${r}/issues/${review.number}/comments`, { body });
      how = "created";
    }
    await this.call("POST", `/repos/${r}/statuses/${review.headSha}`, { state: review.verdict === "GO" ? "success" : review.verdict === "WAIT" ? "pending" : "failure", context: "review-bot", description: statusText(review) });
    return how;
  }
}
