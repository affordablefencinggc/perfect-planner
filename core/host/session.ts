// Who counts as the person. The app window proves it with a one-time launch
// secret that only the process opening the window knows: the production server
// and the dev server put it in the URL fragment of the window they open (or
// print for the person to open), and the desktop shell hands it over its own
// channel. The window claims it once (POST /session/claim) for an HttpOnly
// cookie plus a CSRF token it keeps; the secret is then spent. Every write must
// carry the cookie, the CSRF token and the app's own Origin.
//
// What this does not stop: a process running as the same OS user can read the
// browser's profile or the launcher's output. Agents must run as another user
// or in a sandbox (see core/ledger/README.md "What this does not stop").
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const PERSON_COOKIE = "pp_core_person";
export const CSRF_HEADER = "x-pp-csrf";
const LAUNCH_TTL_MS = 10 * 60_000;

interface Session {
  csrf: string;
  createdAt: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookieValue(req: IncomingMessage, name = PERSON_COOKIE): string | undefined {
  return String(req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** The Origin a request must carry: the app's own, as named by the Host header it was sent to. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return typeof origin === "string" && typeof host === "string" && (origin === `http://${host}` || origin === `https://${host}`);
}

export class PersonSessions {
  /** sha256(launch secret) -> expiry. Only digests are kept. */
  private readonly launches = new Map<string, number>();
  /** sha256(cookie) -> session. */
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh one-time launch secret for the window the caller is about to open. */
  issueLaunch(): string {
    const secret = randomBytes(32).toString("base64url");
    this.launches.set(digest(secret), this.now() + LAUNCH_TTL_MS);
    return secret;
  }

  /** Spends a launch secret; returns the cookie and CSRF token for the window that held it. */
  claim(launch: unknown): { cookie: string; csrf: string } | null {
    if (typeof launch !== "string" || launch.length < 20) return null;
    const key = digest(launch);
    const expires = this.launches.get(key);
    this.launches.delete(key);
    if (!expires || expires < this.now()) return null;
    const cookie = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    this.sessions.set(digest(cookie), { csrf, createdAt: this.now() });
    return { cookie, csrf };
  }

  /** True only for a request from a claimed window: cookie, matching CSRF token and the app's Origin. */
  isPerson(req: IncomingMessage): boolean {
    const cookie = cookieValue(req);
    const csrf = req.headers[CSRF_HEADER];
    if (!cookie || typeof csrf !== "string" || !sameOrigin(req)) return false;
    const session = this.sessions.get(digest(cookie));
    return Boolean(session && same(session.csrf, csrf));
  }

  setCookieHeader(cookie: string, path: string): string {
    return `${PERSON_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=${path}`;
  }
}
