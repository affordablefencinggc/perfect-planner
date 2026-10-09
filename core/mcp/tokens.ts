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
  /**
   * The model this agent runs, set by the person when they issue the token.
   * It is what the ledger records and what Jev's independence check trusts;
   * a model the agent declares itself in hello is recorded as unverified.
   */
  model?: string;
  revoked?: boolean;
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** A short, stable, non-secret id for a token, so an agent keeps its id across reconnects. */
export function tokenId(token: string): string {
  return digest(token).slice(0, 8);
}

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
