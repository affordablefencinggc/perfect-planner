import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function isWithin(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
/**
 * Owner recovery screens (core/ledger/recovery.ts) show or take a one-time recovery code, so they are
 * never captured. They live under /owner-recovery; the path, query and hash are all checked, decoded.
 */
function isOwnerRecoveryTarget(target) {
  let text = `${target.pathname}${target.search}${target.hash}`;
  // Decode until stable (catches double encoding); an address that cannot be decoded fails closed.
  for (let round = 0; round < 5; round += 1) {
    let decoded; try { decoded = decodeURIComponent(text); } catch { return true; }
    if (decoded === text) break; text = decoded;
  }
  return /owner[-_]?recovery/i.test(text.replace(/\+/g, " "));
}
function normalizedTarget(value) {
  let target; try { target = new URL(value); } catch { throw new Error("Screenshot target must be a valid URL."); }
  const localHttp = target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (!(target.protocol === "https:" || localHttp) || target.username || target.password) throw new Error("Screenshot target must be credential-free HTTPS or localhost HTTP.");
  if (isOwnerRecoveryTarget(target)) throw new Error("Screenshot target is an owner recovery screen (or cannot be decoded to rule one out); recovery codes are never captured as evidence.");
  return target.toString();
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

async function assertPhysicalDirectory(root, candidate, label) {
  const resolvedRoot = path.resolve(root); const resolvedCandidate = path.resolve(candidate);
  if (!isWithin(resolvedRoot, resolvedCandidate)) throw new Error(`${label} escapes the approved root.`);
  let cursor = resolvedRoot;
  for (const segment of ["", ...path.relative(resolvedRoot, resolvedCandidate).split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} contains a link, junction, or non-directory path.`);
  }
}

async function runChromiumProcess({ executablePath, args, timeoutMs, maxOutputBytes }) {
  await new Promise((resolve, reject) => {
    let settled = false; let outputBytes = 0; let timer;
    const child = spawn(executablePath, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const collect = (chunk) => { outputBytes += chunk.length; if (outputBytes > maxOutputBytes) { child.kill(); finish(new Error("Chromium output exceeded the configured bound.")); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", finish); child.once("exit", (code, signal) => code === 0 ? finish() : finish(new Error(`Chromium capture failed (${signal ?? `exit ${code}`}).`)));
    timer = setTimeout(() => { child.kill(); finish(new Error("Chromium screenshot capture timed out.")); }, timeoutMs);
  });
}

export function createChromiumScreenshotAdapter(options = {}) {
  const approvedTargets = new Set((options.approvedTargets ?? []).map(normalizedTarget));
  if (!approvedTargets.size) throw new Error("Chromium adapter requires at least one exact approved target.");
  const transport = options.transport;
  const executablePath = options.executablePath ? path.resolve(options.executablePath) : null;
  if ((typeof transport === "function") === Boolean(executablePath)) throw new Error("Chromium adapter requires exactly one direct executable or injected browser transport.");
  if (executablePath) {
    if (!path.isAbsolute(options.executablePath)) throw new Error("Chromium executable path must be absolute.");
    const approvedNames = new Set(["chrome.exe", "msedge.exe", "chromium.exe", "chrome", "google-chrome", "chromium", "microsoft-edge"]);
    if (!approvedNames.has(path.basename(executablePath).toLowerCase())) throw new Error("Chromium executable must be Chrome, Edge, or Chromium.");
  }
  const timeoutMs = boundedInteger(options.timeoutMs, 20_000, 50, 120_000, "Chromium timeout");
  const maxPngBytes = boundedInteger(options.maxPngBytes, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024, "Screenshot byte bound");
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, 64 * 1024, 1024, 1024 * 1024, "Chromium output bound");
  const renderSettleMs = executablePath ? boundedInteger(options.renderSettleMs, 1500, 100, 10_000, "Chromium render-settle window") : null;
  if (executablePath && renderSettleMs >= timeoutMs) throw new Error("Chromium render-settle window must remain below the process timeout.");
  const execute = options.execute ?? runChromiumProcess;
  return async ({ targetUrl, profileDirectory, viewport }) => {
    const exactTarget = normalizedTarget(targetUrl);
    if (!approvedTargets.has(exactTarget)) throw new Error("Screenshot target is not an exact approved target.");
    const resolvedProfile = path.resolve(profileDirectory);
    const profileInfo = await lstat(resolvedProfile);
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || (await readdir(resolvedProfile)).length !== 0) throw new Error("Chromium profile must be a fresh empty physical directory.");
    const width = boundedInteger(viewport?.width, 1440, 320, 7680, "Viewport width");
    const height = boundedInteger(viewport?.height, 900, 180, 4320, "Viewport height");
    const startedAt = Date.now();
    if (transport) {
      const controller = new AbortController();
      let timer;
      try {
        const result = await Promise.race([
          transport({ targetUrl: exactTarget, profileDirectory: resolvedProfile, viewport: { width, height }, signal: controller.signal, timeoutMs, maxPngBytes }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Chromium screenshot capture timed out.")); }, timeoutMs); }),
        ]);
        const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
        if (result?.profileDirectory !== resolvedProfile || result?.fresh !== true || result?.existingSessionUsed !== false) throw new Error("Injected browser transport did not attest the isolated fresh profile.");
        if (!bytes?.length || bytes.length > maxPngBytes) throw new Error("Screenshot bytes are empty or exceed the configured bound.");
        return { bytes, adapterName: result.adapterName ?? "injected-chromium-transport", capturedAt: new Date(startedAt).toISOString() };
      } finally { clearTimeout(timer); controller.abort(); }
    }
    const screenshotPath = path.join(resolvedProfile, "fresh-capture.png");
    if (!isWithin(resolvedProfile, screenshotPath)) throw new Error("Chromium screenshot output escapes the isolated profile.");
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--run-all-compositor-stages-before-draw", `--virtual-time-budget=${renderSettleMs}`, `--user-data-dir=${resolvedProfile}`, `--window-size=${width},${height}`, `--screenshot=${screenshotPath}`, exactTarget];
    await execute({ executablePath, args, timeoutMs, maxOutputBytes, shell: false, windowsHide: true });
    const info = await stat(screenshotPath);
    if (!info.isFile() || info.size <= 0 || info.size > maxPngBytes || info.mtimeMs < startedAt - 1000) throw new Error("Chromium did not produce a fresh bounded screenshot file.");
    return { bytes: await readFile(screenshotPath), adapterName: `direct-${path.basename(executablePath).toLowerCase()}`, capturedAt: new Date(startedAt).toISOString() };
  };
}

export function validatePngScreenshot(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Screenshot is not a valid PNG signature.");
  const chunks = []; let offset = 8; let ended = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("PNG chunk is truncated.");
    const length = buffer.readUInt32BE(offset); const type = buffer.subarray(offset + 4, offset + 8).toString("ascii"); const dataStart = offset + 8; const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("PNG chunk length exceeds the file.");
    const data = buffer.subarray(dataStart, dataEnd); const declaredCrc = buffer.readUInt32BE(dataEnd); const actualCrc = crc32(Buffer.concat([Buffer.from(type), data]));
    if (declaredCrc !== actualCrc) throw new Error(`PNG ${type} checksum is invalid.`);
    chunks.push({ type, data }); offset = dataEnd + 4;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended || offset !== buffer.length || chunks[0]?.type !== "IHDR" || chunks[0].data.length !== 13) throw new Error("PNG structure is incomplete or contains trailing data.");
  const ihdr = chunks[0].data; const width = ihdr.readUInt32BE(0); const height = ihdr.readUInt32BE(4); const bitDepth = ihdr[8]; const colorType = ihdr[9];
  if (!width || !height || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) throw new Error("PNG must be non-interlaced 8-bit grayscale, RGB, grayscale-alpha, or RGBA.");
  if (width < Number(options.minWidth ?? 320) || height < Number(options.minHeight ?? 180)) throw new Error("Screenshot dimensions are below the configured proof minimum.");
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)); if (!compressed.length) throw new Error("PNG has no image data.");
  let raw; try { raw = inflateSync(compressed); } catch { throw new Error("PNG image data cannot be decompressed."); }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType]; const rowBytes = width * channels;
  if (raw.length !== height * (rowBytes + 1)) throw new Error("PNG image data length does not match its dimensions.");
  const pixels = Buffer.alloc(height * rowBytes); let inputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[inputOffset++]; if (filter > 4) throw new Error("PNG uses an unsupported row filter."); const rowStart = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const source = raw[inputOffset++]; const left = column >= channels ? pixels[rowStart + column - channels] : 0; const above = row ? pixels[rowStart - rowBytes + column] : 0; const upperLeft = row && column >= channels ? pixels[rowStart - rowBytes + column - channels] : 0;
      pixels[rowStart + column] = (source + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft))) & 255;
    }
  }
  let first = null; let varied = false; let visiblePixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const start = pixel * channels; const alpha = colorType === 4 ? pixels[start + 1] : colorType === 6 ? pixels[start + 3] : 255; if (alpha === 0) continue; visiblePixels += 1;
    const color = colorType === 0 || colorType === 4 ? [pixels[start]] : [pixels[start], pixels[start + 1], pixels[start + 2]];
    if (!first) first = color; else if (color.some((value, index) => value !== first[index])) { varied = true; break; }
  }
  if (!visiblePixels || !varied) throw new Error("Screenshot is blank, fully transparent, or visually uniform.");
  return Object.freeze({ valid: true, mime: "image/png", width, height, colorType, bitDepth, sha256: sha256(buffer), size: buffer.length, blank: false });
}

async function atomicWrite(filePath, bytes) { await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, filePath); }
async function atomicReplace(filePath, value) { const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, filePath); }
async function readViewingStore(storePath) { try { const info = await lstat(storePath); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Screenshot viewing store must be a physical file."); return JSON.parse(await readFile(storePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, challenges: [], attestations: [] }; throw error; } }
async function validateViewingStorePath(allowedRoot, storePath) { if (!isWithin(allowedRoot, storePath)) throw new Error("Screenshot viewing store escapes the approved evidence root."); await mkdir(path.dirname(path.resolve(storePath)), { recursive: true }); await assertPhysicalDirectory(allowedRoot, path.dirname(path.resolve(storePath)), "Screenshot viewing store path"); }

export async function captureIsolatedScreenshot(input, options = {}) {
  if (typeof input?.adapter !== "function") throw new Error("Screenshot capture requires an explicit adapter.");
  for (const field of ["planId", "itemId", "outputPath", "allowedRoot", "targetUrl"]) if (!String(input?.[field] ?? "").trim()) throw new Error(`Screenshot capture requires ${field}.`);
  const targetUrl = normalizedTarget(input.targetUrl);
  if (!isWithin(input.allowedRoot, input.outputPath)) throw new Error("Screenshot output escapes the approved evidence root.");
  await mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  await assertPhysicalDirectory(input.allowedRoot, path.dirname(path.resolve(input.outputPath)), "Screenshot output path");
  const profileParent = path.resolve(options.profileParent ?? path.join(input.allowedRoot, ".capture-profiles")); if (!isWithin(input.allowedRoot, profileParent)) throw new Error("Capture profile escapes the approved evidence root.");
  await mkdir(profileParent, { recursive: true }); await assertPhysicalDirectory(input.allowedRoot, profileParent, "Capture profile path"); const profileDirectory = await mkdtemp(path.join(profileParent, "isolated-"));
  try {
    const result = await input.adapter({ targetUrl, profileDirectory, viewport: options.viewport ?? { width: 1440, height: 900 } }); const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
    const validation = validatePngScreenshot(bytes, options.validation); await atomicWrite(path.resolve(input.outputPath), bytes);
    return Object.freeze({ schemaVersion: 1, planId: input.planId, itemId: input.itemId, targetUrl, artifactPath: path.resolve(input.outputPath), artifactHash: validation.sha256, width: validation.width, height: validation.height, capturedAt: result?.capturedAt ?? options.timestamp ?? new Date().toISOString(), adapter: result?.adapterName ?? options.adapterName ?? "explicit-adapter", isolatedProfile: true, capturePerformedThisRun: true, viewingStatus: "UNVIEWED" });
  } finally { await rm(profileDirectory, { recursive: true, force: true }); }
}

export function createScreenshotViewingChallenge(record, options = {}) {
  if (!record?.artifactHash || record.viewingStatus !== "UNVIEWED") throw new Error("Viewing challenge requires an unviewed captured screenshot.");
  const createdAt = options.createdAt ?? new Date().toISOString(); const expiresAt = options.expiresAt ?? new Date(Date.parse(createdAt) + 15 * 60_000).toISOString();
  if (!(Date.parse(expiresAt) > Date.parse(createdAt))) throw new Error("Viewing challenge expiry must follow creation.");
  return Object.freeze({ schemaVersion: 1, challengeId: randomUUID(), token: randomBytes(24).toString("base64url"), planId: record.planId, itemId: record.itemId, artifactHash: record.artifactHash, createdAt, expiresAt });
}

export function attestScreenshotViewing(record, challenge, decision, options = {}) {
  const now = Number(options.now ?? Date.now()); const exact = challenge?.planId === record?.planId && challenge?.itemId === record?.itemId && challenge?.artifactHash === record?.artifactHash && decision?.challengeId === challenge?.challengeId && decision?.token === challenge?.token;
  if (!exact || Date.parse(challenge.expiresAt) <= now || decision?.explicitGesture !== true || !String(decision?.actor ?? "").trim() || String(decision?.observation ?? "").trim().length < 12) throw new Error("Screenshot viewing requires a current exact challenge, named actor, explicit gesture, and concrete observation.");
  return Object.freeze({ ...record, viewingStatus: "VIEWED", viewedAt: options.timestamp ?? new Date(now).toISOString(), viewedBy: String(decision.actor), observation: String(decision.observation).trim(), viewingChallengeId: challenge.challengeId });
}

export async function issueDurableScreenshotViewingChallenge(storePath, record, options = {}) {
  const requestedViewer = String(options.requestedViewer ?? "").trim();
  if (!requestedViewer) throw new Error("Durable screenshot viewing requires one named requested viewer.");
  await validateViewingStorePath(options.allowedRoot, storePath); const validation = await revalidateScreenshotRecord(record, options.validation); if (validation.sha256 !== record.artifactHash) throw new Error("Screenshot artifact hash changed before viewing challenge creation.");
  return withPlanLock(storePath, { actor: options.actor ?? requestedViewer, timeoutMs: options.lockTimeoutMs ?? 5000 }, async () => {
    const store = await readViewingStore(storePath); const now = Number(options.now ?? Date.now());
    const active = store.challenges.find((item) => item.status === "PENDING" && item.planId === record.planId && item.itemId === record.itemId && item.artifactHash === record.artifactHash && Date.parse(item.expiresAt) > now);
    if (active) throw new Error("An unexpired viewing challenge already exists for this exact screenshot.");
    const challenge = createScreenshotViewingChallenge(record, { createdAt: options.createdAt, expiresAt: options.expiresAt });
    if (Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt) > 60 * 60_000) throw new Error("Durable viewing challenge lifetime cannot exceed one hour.");
    const stored = { ...challenge, token: "REDACTED", tokenHash: sha256(challenge.token), requestedViewer, status: "PENDING" };
    store.challenges.push(stored); await atomicReplace(path.resolve(storePath), store);
    return Object.freeze({ ...challenge, requestedViewer });
  });
}

export async function completeDurableScreenshotViewing(storePath, record, decision, options = {}) {
  await validateViewingStorePath(options.allowedRoot, storePath); const validation = await revalidateScreenshotRecord(record, options.validation); if (validation.sha256 !== record.artifactHash) throw new Error("Screenshot artifact hash changed before viewing attestation.");
  const actor = String(decision?.actor ?? "").trim();
  return withPlanLock(storePath, { actor: actor || "unnamed-viewer", timeoutMs: options.lockTimeoutMs ?? 5000 }, async () => {
    const store = await readViewingStore(storePath); const stored = store.challenges.find((item) => item.challengeId === decision?.challengeId);
    if (!stored || stored.status !== "PENDING" || stored.requestedViewer !== actor || sha256(String(decision?.token ?? "")) !== stored.tokenHash) throw new Error("Durable screenshot viewing requires the exact pending challenge and named requested viewer.");
    const challenge = { ...stored, token: decision.token };
    const attestation = attestScreenshotViewing(record, challenge, decision, options);
    stored.status = "VIEWED"; stored.completedAt = attestation.viewedAt; stored.tokenHash = "REDACTED";
    store.attestations.push(attestation); await atomicReplace(path.resolve(storePath), store); return attestation;
  });
}

export async function inspectDurableScreenshotViewing(storePath, options = {}) {
  await validateViewingStorePath(options.allowedRoot, storePath); const store = await readViewingStore(storePath);
  return Object.freeze({ schemaVersion: 1, challenges: store.challenges.map(({ tokenHash: _tokenHash, ...item }) => ({ ...item, token: "REDACTED" })), attestations: store.attestations.map((item) => ({ ...item })) });
}

export async function revalidateScreenshotRecord(record, options = {}) { return validatePngScreenshot(await readFile(record.artifactPath), options); }
