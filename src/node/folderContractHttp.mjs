import { randomBytes, timingSafeEqual } from "node:crypto";
import { inspectFolderContracts, publishFolderContract } from "./folderContractStore.mjs";
import { isSameOriginLoopbackRequest } from "./loopbackRequestHttp.mjs";

const json = (res, status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.end(JSON.stringify(value)); };
const sameOrigin = isSameOriginLoopbackRequest;
const sameToken = (provided, expected) => { const left = Buffer.from(provided ?? ""); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); };
async function readBody(req, limit = 512_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Folder publication exceeds its byte limit."); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }

export function createFolderContractMiddleware({ root, actor = "local-user", token = randomBytes(32).toString("hex") }) {
  return async (req, res, next = () => json(res, 404, { error: "Not found." })) => { const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`); if (!url.pathname.startsWith("/api/folder-contract/")) return next(); if (!sameOrigin(req)) return json(res, 403, { error: "Exact same-origin request required." });
    if (url.pathname === "/api/folder-contract/session" && ["GET", "POST"].includes(req.method)) { if (req.method === "POST") { try { if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw Error(); const body = await readBody(req, 1024); if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw Error(); } catch { return json(res, 400, { error: "Empty JSON session request required." }); } } return json(res, 200, { schemaVersion: 1, token, actor }); }
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON POST required." }); if (!sameToken(req.headers["x-pp-folder-token"], token)) return json(res, 403, { error: "Folder publication capability refused." });
    try { const request = await readBody(req); let result; if (url.pathname.endsWith("/inspect")) result = await inspectFolderContracts(root, request.planId); else if (url.pathname.endsWith("/publish")) result = await publishFolderContract(root, request.input, { planId: request.input?.planId, architectureContractDigest: request.architectureContractDigest, architectureRevision: request.architectureRevision, expectedRevision: request.expectedRevision, expectedHeadDigest: request.expectedHeadDigest }, { actor }); else return json(res, 404, { error: "Unknown folder operation." }); return json(res, 200, result); }
    catch (error) { return json(res, /compare-and-swap|already registered/.test(error.message) ? 409 : 400, { error: error.message }); }
  };
}
