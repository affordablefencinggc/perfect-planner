import { randomBytes, timingSafeEqual } from "node:crypto";
import { approveCollisionOrder, commitCollisionAssessment, inspectCollisionAuthority } from "./collisionAuthorityStore.mjs";

const json = (res, status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.end(JSON.stringify(value)); };
const sameOrigin = (req) => { const origin = req.headers.origin; const host = req.headers.host; return Boolean(origin && host && (origin === `http://${host}` || origin === `https://${host}`)); };
const equalToken = (provided, expected) => { try { const left = Buffer.from(provided ?? ""); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); } catch { return false; } };
async function readBody(req, limit = 256_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Authority request exceeds its byte limit."); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }

export function createCollisionAuthorityMiddleware({ root, actor = "local-user", token = randomBytes(32).toString("hex") }) {
  return async (req, res, next = () => json(res, 404, { error: "Not found." })) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`); if (!url.pathname.startsWith("/api/collision-authority/")) return next();
    if (!sameOrigin(req)) return json(res, 403, { error: "Exact same-origin request required." });
    if (url.pathname === "/api/collision-authority/session" && req.method === "GET") return json(res, 200, { schemaVersion: 1, token });
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON POST required." });
    if (!equalToken(req.headers["x-pp-authority-token"], token)) return json(res, 403, { error: "Authority capability token refused." });
    try {
      const request = await readBody(req); let result;
      if (url.pathname.endsWith("/inspect")) result = await inspectCollisionAuthority(root, request);
      else if (url.pathname.endsWith("/approve")) result = await approveCollisionOrder(root, request, { actor });
      else if (url.pathname.endsWith("/commit")) result = await commitCollisionAssessment(root, request, { actor });
      else return json(res, 404, { error: "Unknown authority operation." });
      return json(res, 200, result);
    } catch (error) { return json(res, /compare-and-swap|already/.test(error.message) ? 409 : 400, { error: error.message }); }
  };
}
