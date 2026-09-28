import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { censusRepository } from "./repositoryCensus.mjs";
import { withPlanLock } from "./planLock.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableId = (rootId, filePath) => `SRC-AUTO-${sha256(`${rootId}:${filePath}`).slice(0, 12).toUpperCase()}`;

async function readRegistry(registryPath) {
  try {
    const value = JSON.parse(await readFile(registryPath, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.sources) || !Array.isArray(value.roots)) throw new Error("Document registry is malformed.");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, generation: 0, roots: [], sources: [] };
    throw error;
  }
}

async function atomicWrite(registryPath, registry) {
  await mkdir(path.dirname(path.resolve(registryPath)), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, registryPath);
}

export async function reconcileRegisteredRoots(registryPath, roots, options = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("Document reconciliation requires at least one registered root.");
  const rootIds = new Set();
  for (const root of roots) {
    if (!String(root.id ?? "").trim() || !String(root.path ?? "").trim() || rootIds.has(root.id)) throw new Error("Registered roots require unique ids and explicit paths.");
    rootIds.add(root.id);
  }
  const observedAt = options.observedAt ?? new Date().toISOString();
  const snapshots = [];
  for (const root of roots) snapshots.push({ root, census: await censusRepository(root.path, { generatedAt: observedAt, ignored: root.ignored, extensions: root.extensions, maxFiles: root.maxFiles ?? options.maxFiles, maxBytes: root.maxBytes ?? options.maxBytes }) });
  await mkdir(path.dirname(path.resolve(registryPath)), { recursive: true });
  return withPlanLock(registryPath, { actor: options.actor ?? "document-reconciler", timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const registry = await readRegistry(registryPath);
    const byKey = new Map(registry.sources.map((source) => [`${source.rootId}:${source.path}`, source]));
    const seen = new Set(); const events = [];
    for (const { root, census } of snapshots) {
      for (const file of census.files) {
        const key = `${root.id}:${file.path}`; seen.add(key); const existing = byKey.get(key);
        if (!existing) {
          const source = { sourceId: stableId(root.id, file.path), rootId: root.id, path: file.path, category: file.category, state: "active", firstSeen: observedAt, lastSeen: observedAt, sha256: file.sha256, size: file.size, revisions: [{ observedAt, sha256: file.sha256, size: file.size }] };
          registry.sources.push(source); byKey.set(key, source); events.push({ action: "added", sourceId: source.sourceId, rootId: root.id, path: file.path, sha256: file.sha256 });
        } else {
          existing.lastSeen = observedAt;
          if (existing.state === "deleted") { existing.state = "active"; events.push({ action: "restored", sourceId: existing.sourceId, rootId: root.id, path: file.path, sha256: file.sha256 }); }
          if (existing.sha256 !== file.sha256) { existing.sha256 = file.sha256; existing.size = file.size; existing.revisions.push({ observedAt, sha256: file.sha256, size: file.size }); events.push({ action: "changed", sourceId: existing.sourceId, rootId: root.id, path: file.path, sha256: file.sha256 }); }
        }
      }
      for (const skipped of census.skipped) events.push({ action: "refused", rootId: root.id, path: skipped.path, reason: skipped.reason });
    }
    for (const source of registry.sources) {
      const key = `${source.rootId}:${source.path}`;
      if (rootIds.has(source.rootId) && source.state === "active" && !seen.has(key)) { source.state = "deleted"; source.deletedAt = observedAt; events.push({ action: "deleted", sourceId: source.sourceId, rootId: source.rootId, path: source.path, previousSha256: source.sha256 }); }
    }
    registry.generation += 1;
    registry.lastReconciledAt = observedAt;
    registry.roots = roots.map((root) => ({ id: root.id, path: path.resolve(root.path) }));
    registry.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    await atomicWrite(registryPath, registry);
    return { generation: registry.generation, events, counts: { total: registry.sources.length, active: registry.sources.filter((source) => source.state === "active").length, deleted: registry.sources.filter((source) => source.state === "deleted").length, added: events.filter((event) => event.action === "added").length, changed: events.filter((event) => event.action === "changed").length, refused: events.filter((event) => event.action === "refused").length }, registry };
  });
}

export function startDocumentWatcher(registryPath, roots, options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 5000));
  let stopped = false; let running = null; let timer = null;
  const runNow = async () => {
    if (stopped) throw new Error("Document watcher is stopped.");
    if (running) return running;
    running = reconcileRegisteredRoots(registryPath, roots, options).then((result) => { options.onUpdate?.(result); return result; }).catch((error) => { options.onError?.(error); throw error; }).finally(() => { running = null; });
    return running;
  };
  timer = setInterval(() => { runNow().catch(() => {}); }, intervalMs);
  if (options.unref !== false) timer.unref?.();
  return { runNow, stop: () => { stopped = true; if (timer) clearInterval(timer); timer = null; }, get stopped() { return stopped; }, get running() { return running !== null; }, get currentRun() { return running; } };
}

export async function inspectDocumentRegistry(registryPath) { return readRegistry(registryPath); }

const hostJson = (res, status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.end(JSON.stringify(value)); };
const exactOrigin = (req) => Boolean(req.headers.origin && req.headers.host && (req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`));

export async function startLocalAuthorityHost(options = {}) {
  const registrations = options.documentWatchers ?? [];
  if (!registrations.length) throw new Error("Local authority host requires at least one registered document watcher.");
  const ids = new Set();
  for (const item of registrations) if (!String(item.id ?? "").trim() || ids.has(item.id) || !String(item.registryPath ?? "").trim() || !item.roots?.length) throw new Error("Local authority watchers require unique ids, registry paths, and roots."); else ids.add(item.id);
  const middleware = options.middleware ?? [];
  if (!middleware.every((item) => typeof item === "function")) throw new Error("Local authority middleware entries must be functions.");
  const status = new Map(); let state = "starting"; let closedAt = null;
  const watchers = new Map(registrations.map((item) => {
    status.set(item.id, { id: item.id, state: "starting", generation: 0, lastSuccessAt: null, lastError: null });
    const watcher = startDocumentWatcher(item.registryPath, item.roots, { ...item.options, intervalMs: item.intervalMs ?? options.intervalMs, actor: item.actor ?? options.actor ?? "local-authority-host", onUpdate: (result) => { status.set(item.id, { id: item.id, state: "healthy", generation: result.generation, lastSuccessAt: result.registry.lastReconciledAt, lastError: null }); if (state === "degraded" && [...status.values()].every((entry) => entry.state === "healthy")) state = "running"; item.options?.onUpdate?.(result); }, onError: (error) => { const prior = status.get(item.id); status.set(item.id, { ...prior, state: "failed", lastError: error.message }); if (state === "running") state = "degraded"; item.options?.onError?.(error); } });
    return [item.id, watcher];
  }));
  try { await Promise.all([...watchers.values()].map((watcher) => watcher.runNow())); }
  catch (error) { for (const watcher of watchers.values()) watcher.stop(); await Promise.all([...watchers.values()].map((watcher) => watcher.currentRun?.catch(() => {}))); throw new Error(`Local authority host startup refused: ${error.message}`); }
  const health = () => ({ schemaVersion: 1, state, watcherCount: watchers.size, watchers: [...status.values()], mountedMiddleware: middleware.length, closedAt });
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/local-authority/health") return exactOrigin(req) ? hostJson(res, state === "running" ? 200 : 503, health()) : hostJson(res, 403, { error: "Exact same-origin request required." });
    if (state !== "running") return hostJson(res, 503, health());
    let index = 0;
    const next = () => { const handler = middleware[index++]; if (!handler) return hostJson(res, 404, { error: "Not found." }); return Promise.resolve(handler(req, res, next)).catch((error) => hostJson(res, 500, { error: `Authority middleware failed: ${error.message}` })); };
    next();
  });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", resolve); }); }
  catch (error) { for (const watcher of watchers.values()) watcher.stop(); throw new Error(`Local authority host listen refused: ${error.message}`); }
  state = "running";
  const address = server.address(); const origin = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => { state = "closing"; for (const watcher of watchers.values()) watcher.stop(); await Promise.all([...watchers.values()].map((watcher) => watcher.currentRun?.catch(() => {}))); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); state = "closed"; closedAt = new Date().toISOString(); return health(); })();
    return closing;
  };
  return { origin, health, close, runWatcher: (id) => { if (!["running", "degraded"].includes(state)) return Promise.reject(new Error("Local authority host is not running.")); const watcher = watchers.get(id); if (!watcher) return Promise.reject(new Error(`Unknown document watcher ${id}.`)); return watcher.runNow(); }, get state() { return state; } };
}
