import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { PersonSessions, personCookieName, cookieValue, CSRF_HEADER } from "./session";
import { claimLaunch, startTestHost } from "./testing";

function request(port: number | undefined, cookie = "", csrf = ""): IncomingMessage {
  return { socket: { localPort: port }, headers: { host: "127.0.0.1:41730", origin: "http://127.0.0.1:41730", cookie, [CSRF_HEADER]: csrf } } as unknown as IncomingMessage;
}

describe("port-scoped person sessions", () => {
  it("uses the actual local port for both emission and reading, and rejects another port's name", () => {
    const sessions = new PersonSessions();
    const claimed = sessions.claim(sessions.issueLaunch())!;
    const first = sessions.setCookieHeader(claimed.cookie, "/api", request(41730));
    const second = sessions.setCookieHeader(claimed.cookie, "/api", request(41731));
    expect(first).toBe("pp_core_person_41730=" + claimed.cookie + "; HttpOnly; SameSite=Strict; Path=/api");
    expect(second).toBe("pp_core_person_41731=" + claimed.cookie + "; HttpOnly; SameSite=Strict; Path=/api");
    const cookie = first.split(";")[0];
    const onFirst = request(41730, cookie, claimed.csrf);
    const onSecond = request(41731, cookie, claimed.csrf);
    expect(sessions.hasSession(onFirst)).toBe(true);
    expect(sessions.sessionId(onFirst)).not.toBeNull();
    expect(sessions.isPerson(onFirst)).toBe(true);
    expect(cookieValue(onSecond)).toBeUndefined();
    expect(sessions.hasSession(onSecond)).toBe(false);
    expect(sessions.sessionId(onSecond)).toBeNull();
    expect(sessions.isPerson(onSecond)).toBe(false);
    expect(sessions.hasSession(request(41730, "pp_core_person=" + claimed.cookie, claimed.csrf))).toBe(false);
  });

  it.each([undefined, 0, -1, 65536, 1.5, Number.NaN])("fails closed without a valid local serving port: %s", (port) => {
    const sessions = new PersonSessions();
    const claimed = sessions.claim(sessions.issueLaunch())!;
    const req = request(port, "pp_core_person=" + claimed.cookie + "; pp_core_person_41730=" + claimed.cookie, claimed.csrf);
    expect(personCookieName(req)).toBeUndefined();
    expect(sessions.hasSession(req)).toBe(false);
    expect(sessions.sessionId(req)).toBeNull();
    expect(sessions.isPerson(req)).toBe(false);
    expect(() => sessions.setCookieHeader(claimed.cookie, "/api", req)).toThrow("no local serving port");
  });

  it("the actual claim route emits distinct port-qualified cookies and rejects cross-port use", async () => {
    const a = await startTestHost();
    const b = await startTestHost();
    try {
      const first = await claimLaunch(a.base, a.host.issueLaunch());
      const second = await claimLaunch(b.base, b.host.issueLaunch());
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.cookie?.split("=")[0]).toBe("pp_core_person_" + new URL(a.base).port);
      expect(second.cookie?.split("=")[0]).toBe("pp_core_person_" + new URL(b.base).port);
      expect(first.cookie?.split("=")[0]).not.toBe(second.cookie?.split("=")[0]);
      const accepted = await fetch(a.base + "/status", { headers: { cookie: first.cookie! } });
      expect(accepted.status).toBe(200);
      await accepted.arrayBuffer();
      const rejected = await fetch(b.base + "/status", { headers: { cookie: first.cookie! } });
      expect(rejected.status).toBe(401);
      await rejected.arrayBuffer();
    } finally { await a.stop(); await b.stop(); }
  });
});
