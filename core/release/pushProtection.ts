// Layer 4: GitHub secret-scanning push protection. Injected fetcher, so tests
// need no network. The token is only ever sent in the Authorization header and
// is stripped from anything returned or thrown.

export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<any> }>;

export interface PushProtectionOptions {
  owner: string;
  repo: string;
  token: string;
}

export type PushProtectionStatus = "enabled" | "disabled" | "unavailable" | "unknown";

export interface PushProtectionResult {
  status: PushProtectionStatus;
  detail: string;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

function url(o: PushProtectionOptions): string {
  return `https://api.github.com/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}`;
}

function failure(err: unknown, token: string): PushProtectionResult {
  let msg = err instanceof Error ? err.message : String(err);
  if (token) msg = msg.split(token).join("***");
  return { status: "unknown", detail: `Could not reach GitHub: ${msg}` };
}

function httpProblem(status: number): PushProtectionResult {
  if (status === 404 || status === 403) {
    return { status: "unknown", detail: "GitHub would not show this repository's settings. Check the repository name and that your token can administer it." };
  }
  if (status === 401) return { status: "unknown", detail: "GitHub rejected the token. Sign in again and retry." };
  return { status: "unknown", detail: `GitHub answered with status ${status}.` };
}

export async function checkPushProtection(fetcher: Fetcher, opts: PushProtectionOptions): Promise<PushProtectionResult> {
  try {
    const res = await fetcher(url(opts), { method: "GET", headers: headers(opts.token) });
    if (res.status !== 200) return httpProblem(res.status);
    const body = await res.json();
    const value = body?.security_and_analysis?.secret_scanning_push_protection?.status;
    if (value === undefined || value === null) {
      return { status: "unavailable", detail: "Push protection is not offered for this repository's plan." };
    }
    if (value === "enabled") return { status: "enabled", detail: "GitHub blocks pushes that contain known secrets." };
    if (value === "disabled") return { status: "disabled", detail: "Push protection is off. GitHub will not block pushes that contain secrets." };
    return { status: "unknown", detail: "GitHub reported an unrecognised push protection state." };
  } catch (err) {
    return failure(err, opts.token);
  }
}

export async function enablePushProtection(fetcher: Fetcher, opts: PushProtectionOptions): Promise<PushProtectionResult> {
  try {
    const res = await fetcher(url(opts), {
      method: "PATCH",
      headers: { ...headers(opts.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      }),
    });
    if (res.status === 422) {
      return { status: "unavailable", detail: "GitHub refused: push protection is not offered for this repository's plan." };
    }
    if (res.status < 200 || res.status >= 300) return httpProblem(res.status);
  } catch (err) {
    return failure(err, opts.token);
  }
  return checkPushProtection(fetcher, opts);
}
