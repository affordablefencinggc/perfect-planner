// Agent tokens (spec §4.1): a worker's token covers only its own task; a
// connect token lets an agent say hello, and the first agent to do so for a
// person becomes that person's main chat (spec §9.5: helpers get their own).
// Only SHA-256 digests of tokens are kept; the raw token is returned once.
import { createHash, randomBytes } from "node:crypto";

export type GrantRole = "connect" | "worker";

export interface Grant {
  role: GrantRole;
  /** The owner or helper this agent works for. */
  person: string;
  /** Worker tokens only: the one task the token covers. */
  task?: string;
  revoked?: boolean;
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export class TokenStore {
  private readonly grants = new Map<string, Grant>();

  issue(grant: Omit<Grant, "revoked">): string {
    if (grant.role === "worker" && !grant.task) throw new Error("A worker token must name its task.");
    const token = `pp_${grant.role === "worker" ? "w" : "c"}_${randomBytes(24).toString("base64url")}`;
    this.grants.set(digest(token), { ...grant });
    return token;
  }

  resolve(token: unknown): Grant | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
    const grant = this.grants.get(digest(token));
    return grant && !grant.revoked ? { ...grant } : null;
  }

  revoke(token: string): boolean {
    const grant = this.grants.get(digest(token));
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  /** Revoke every worker token for a task (on release, reopen or merge). */
  revokeTask(task: string): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.role === "worker" && grant.task === task && !grant.revoked) {
        grant.revoked = true;
        count++;
      }
    }
    return count;
  }
}
