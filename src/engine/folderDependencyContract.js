// C010 folder structure contract: dependency wiring belongs to the same pre-build authority.
const LAYERS = Object.freeze(["credentials", "middleware", "third-party"]);
const STATES = new Set(["live", "ready", "attention", "disconnected", "unavailable"]);

export const dependencyConnectionSeed = Object.freeze({
  schemaVersion: 1,
  nodes: Object.freeze([
    { id: "D01", layer: "credentials", name: "OS credential vault", detail: "Device-bound identity and secret handles", state: "attention" },
    { id: "D02", layer: "credentials", name: "Git identity", detail: "Optional Git/GitHub signing and access", state: "disconnected" },
    { id: "D03", layer: "credentials", name: "CI secret handles", detail: "Opaque deployment and status credentials", state: "disconnected" },
    { id: "D04", layer: "credentials", name: "AI provider keys", detail: "Opaque model and reviewer handles", state: "attention" },
    { id: "D05", layer: "middleware", name: "Native capability gate", detail: "Exact commands; deny everything else", state: "ready" },
    { id: "D06", layer: "middleware", name: "Workspace census", detail: "Registered root; metadata and hashes only", state: "unavailable" },
    { id: "D07", layer: "middleware", name: "Collision broker", detail: "Blocks overlapping file and resource claims", state: "ready" },
    { id: "D08", layer: "middleware", name: "Proof runner", detail: "Bounded checks and screenshot receipts", state: "ready" },
    { id: "D09", layer: "middleware", name: "Deployment adapter", detail: "Build truth before any release action", state: "ready" },
    { id: "D10", layer: "third-party", name: "GitHub", detail: "Optional source hosting and status", state: "disconnected" },
    { id: "D11", layer: "third-party", name: "Cloudflare Sites", detail: "Static preview and deployment", state: "ready" },
    { id: "D12", layer: "third-party", name: "Chrome proof", detail: "Isolated browser screenshot adapter", state: "ready" },
    { id: "D13", layer: "third-party", name: "Edge proof", detail: "Independent WebView/browser proof", state: "disconnected" },
    { id: "D14", layer: "third-party", name: "Model providers", detail: "Build and independent review models", state: "disconnected" },
  ]),
  edges: Object.freeze([
    { from: "D01", to: "D05" }, { from: "D02", to: "D07" }, { from: "D03", to: "D09" }, { from: "D04", to: "D08" },
    { from: "D05", to: "D06" }, { from: "D05", to: "D07" }, { from: "D05", to: "D08" }, { from: "D05", to: "D09" },
    { from: "D02", to: "D10" }, { from: "D07", to: "D10" }, { from: "D09", to: "D11" }, { from: "D08", to: "D12" }, { from: "D08", to: "D13" }, { from: "D04", to: "D14" },
  ]),
});

export function assessDependencyConnectionMap(input, stateOverrides = {}) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input?.nodes) || !Array.isArray(input?.edges)) throw new Error("Dependency map requires schema version one, nodes, and edges.");
  const ids = new Set();
  const nodes = input.nodes.map((node) => {
    if (!/^D\d{2,}$/.test(node?.id ?? "") || ids.has(node.id)) throw new Error(`Dependency node identity is invalid or duplicated: ${node?.id ?? "missing"}.`);
    ids.add(node.id);
    if (!LAYERS.includes(node.layer) || !String(node.name ?? "").trim() || !String(node.detail ?? "").trim()) throw new Error(`${node.id} has an incomplete dependency contract.`);
    const state = stateOverrides[node.id] ?? node.state;
    if (!STATES.has(state)) throw new Error(`${node.id} has an unsupported connection state.`);
    return Object.freeze({ ...node, state });
  });
  const seenEdges = new Set();
  const edges = input.edges.map((edge) => {
    const key = `${edge?.from}->${edge?.to}`;
    if (!ids.has(edge?.from) || !ids.has(edge?.to) || edge.from === edge.to || seenEdges.has(key)) throw new Error(`Dependency connection is invalid or duplicated: ${key}.`);
    seenEdges.add(key);
    const from = nodes.find((node) => node.id === edge.from); const to = nodes.find((node) => node.id === edge.to);
    if (LAYERS.indexOf(from.layer) > LAYERS.indexOf(to.layer)) throw new Error(`${key} points against the Credentials → Middleware → Third parties flow.`);
    return Object.freeze({ ...edge, state: [from.state, to.state].includes("disconnected") || [from.state, to.state].includes("unavailable") ? "open" : "connected" });
  });
  const counts = Object.freeze(Object.fromEntries([...STATES].map((state) => [state, nodes.filter((node) => node.state === state).length])));
  return Object.freeze({ schemaVersion: 1, layers: LAYERS, nodes: Object.freeze(nodes), edges: Object.freeze(edges), counts, connectedPercentage: Math.floor((edges.filter((edge) => edge.state === "connected").length / Math.max(edges.length, 1)) * 100) });
}
