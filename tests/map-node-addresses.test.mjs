import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { appMapRegistry } from "../src/engine/appMapRegistry.js";

const mapsDirectory = new URL("../docs/architecture/maps/", import.meta.url);
const mapDocumentPattern = /^(\d{2})-[a-z0-9-]+\.md$/;

const nodePattern = /(?:^|[\s>])([A-Za-z][A-Za-z0-9_]*)\s*(?:\[\s*"([^"]+)"\s*\]|\{\s*"([^"]+)"\s*\})/gm;

function registeredMapDocuments(registry, fileNames) {
  const blockers = [];
  const registeredIds = new Set();
  for (const map of registry?.maps ?? []) {
    if (!/^M\d{2}$/.test(map?.id ?? "")) blockers.push(`Registered map id ${map?.id ?? "<missing>"} must use M00 form.`);
    else if (registeredIds.has(map.id)) blockers.push(`Registered map id ${map.id} is duplicated.`);
    registeredIds.add(map?.id);
  }

  const documents = (fileNames ?? []).filter((file) => mapDocumentPattern.test(file)).sort();
  const byId = new Map();
  for (const file of documents) {
    const id = `M${file.match(mapDocumentPattern)[1]}`;
    const matches = byId.get(id) ?? [];
    matches.push(file);
    byId.set(id, matches);
  }

  for (const id of registeredIds) {
    const matches = byId.get(id) ?? [];
    if (matches.length === 0) blockers.push(`${id} has no numbered map document.`);
    if (matches.length > 1) blockers.push(`${id} has multiple numbered map documents: ${matches.join(", ")}.`);
  }
  for (const [id, matches] of byId) if (!registeredIds.has(id)) blockers.push(`${matches.join(", ")} resolves to unregistered map ${id}.`);
  assert.deepEqual(blockers, [], blockers.join("\n"));
  return [...registeredIds].sort().map((id) => byId.get(id)[0]);
}

test("registered maps and numbered map documents reconcile exactly once", async () => {
  const entries = await readdir(mapsDirectory, { withFileTypes: true });
  const mapFiles = registeredMapDocuments(appMapRegistry, entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  assert.equal(mapFiles.length, appMapRegistry.maps.length);
});

test("map document discovery fails closed for missing, duplicate, or unregistered maps", () => {
  const registry = { maps: [{ id: "M00" }, { id: "M01" }] };
  assert.throws(() => registeredMapDocuments(registry, ["00-atlas.md"]), /M01 has no numbered map document/);
  assert.throws(() => registeredMapDocuments(registry, ["00-atlas.md", "01-one.md", "01-copy.md"]), /M01 has multiple numbered map documents/);
  assert.throws(() => registeredMapDocuments(registry, ["00-atlas.md", "01-one.md", "02-orphan.md"]), /unregistered map M02/);
});

test("every registered map Mermaid process node has a stable 1a-style address", async () => {
  const entries = await readdir(mapsDirectory, { withFileTypes: true });
  const mapFiles = registeredMapDocuments(appMapRegistry, entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const file of mapFiles) {
    const source = await readFile(new URL(file, mapsDirectory), "utf8");
    const mapNumber = String(Number(file.slice(0, 2)));
    const blocks = [...source.matchAll(/```mermaid\s*([\s\S]*?)```/g)].map((match) => match[1]);
    assert.ok(blocks.length > 0, `${file} has no Mermaid map`);

    const addresses = new Set();
    for (const block of blocks) {
      const nodeSource = block.split("\n").filter((line) => !line.trimStart().startsWith("subgraph ")).join("\n");
      for (const match of nodeSource.matchAll(nodePattern)) {
        const label = match[2] ?? match[3];
        const address = label.match(new RegExp(`^${mapNumber}([a-z]) ·`))?.[0];
        const strongerIdentity = /^(?:M\d{2}|C\d{3,}|F\d{3,}) ·/.test(label);
        assert.ok(address || strongerIdentity, `${file} node ${match[1]} is missing a ${mapNumber}a-style address: ${label}`);
        if (address) {
          assert.equal(addresses.has(address), false, `${file} duplicates process address ${address}`);
          addresses.add(address);
        }
      }
    }
  }
});
