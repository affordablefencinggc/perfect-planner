import React from "react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import {
  createMemoryStorage,
  createProjectRegistry,
} from "../src/project/projectRegistry.js";

const artifactNames = [
  "truth-core-report.json",
  "completion-report.json",
  "completion-report.md",
  "evidence-bundle.html",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function response(bytes, { ok = true, status = 200 } = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ok,
    status,
    redirected: false,
    headers: {
      get(name) {
        if (name === "content-type") return "application/json";
        if (name === "content-length") return String(body.byteLength);
        return null;
      },
    },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function generationFixture({ tamperHash = false } = {}) {
  const generatedAt = new Date().toISOString();
  const reportBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      census: { fileCount: 312, skipped: 0, digest: "a".repeat(64) },
      journal: { valid: true, entries: 25, concurrentWriters: 4 },
      proofRunner: { proven: true },
      sessionRegistry: { valid: true },
      confirmationStore: { failClosed: true, state: "waiting" },
      mutationGate: { totals: { killed: 22, total: 22 } },
    }),
  );
  const artifacts = artifactNames.map((name, index) => ({
    name,
    sha256:
      index === 0
        ? tamperHash
          ? "f".repeat(64)
          : sha(reportBytes)
        : sha(Buffer.from(`artifact-${index}`)),
    size:
      index === 0
        ? reportBytes.byteLength
        : Buffer.byteLength(`artifact-${index}`),
  }));
  const generationId = sha(
    Buffer.from(
      artifacts
        .map((artifact) => `${artifact.name}:${artifact.sha256}`)
        .join("\n"),
    ),
  );
  return {
    reportBytes,
    pointer: {
      schemaVersion: 1,
      generationId,
      generatedAt,
      directory: `generations/${generationId}`,
      artifacts,
    },
  };
}

function renderIntegrity() {
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const demo = createDemoProjectSession();
  registry.upsert(demo);
  window.history.replaceState(
    {},
    "",
    `/?project=${demo.projectId}&workspace=integrity`,
  );
  return render(
    <ProjectProvider registry={registry} initialUrl={window.location.href}>
      <PerfectPlannerShell />
    </ProjectProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async (_algorithm, bytes) => {
        const digest = createHash("sha256").update(bytes).digest();
        return digest.buffer.slice(
          digest.byteOffset,
          digest.byteOffset + digest.byteLength,
        );
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Integrity current-generation truth", () => {
  test("shows verified data only after the immutable generation hash passes", async () => {
    const fixture = generationFixture();
    const fetchImpl = vi.fn(async (url) =>
      url === "/generated/current-generation.json"
        ? response(JSON.stringify(fixture.pointer))
        : response(fixture.reportBytes),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const { container } = renderIntegrity();

    await screen.findByText(/verified \d/);
    const truthPanel = container.querySelector(".truth-panel");
    expect(within(truthPanel).getByText("312")).toBeTruthy();
    expect(within(truthPanel).getByText("VALID")).toBeTruthy();
    // Demo also reads its saved collision decisions once (top bar and gates); that is not an integrity read.
    expect(fetchImpl.mock.calls.map(([url]) => url).filter((url) => !String(url).startsWith("/api/collision-authority/") && !String(url).startsWith("/api/core/"))).toEqual([
      "/generated/current-generation.json",
      `/generated/${fixture.pointer.directory}/truth-core-report.json`,
    ]);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      "/generated/truth-core-report.json",
      expect.anything(),
    );
  });

  test("shows invalid and withholds report values when the pointed bytes fail SHA-256", async () => {
    const fixture = generationFixture({ tamperHash: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        url === "/generated/current-generation.json"
          ? response(JSON.stringify(fixture.pointer))
          : response(fixture.reportBytes),
      ),
    );
    const { container } = renderIntegrity();

    await screen.findByText("current generation invalid");
    const truthPanel = container.querySelector(".truth-panel");
    expect(
      within(truthPanel).getByText(
        "The current truth report failed its SHA-256 integrity check.",
      ),
    ).toBeTruthy();
    expect(
      within(truthPanel).getByRole("button", { name: "Retry current report" }),
    ).toBeTruthy();
    expect(within(truthPanel).queryByText("312")).toBeNull();
  });

  test("shows unavailable rather than zero when the current pointer cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response("{}", { ok: false, status: 503 })),
    );
    const { container } = renderIntegrity();

    await screen.findByText("current generation unavailable");
    const truthPanel = container.querySelector(".truth-panel");
    expect(
      within(truthPanel).getByText(
        "The current truth generation pointer is unavailable.",
      ),
    ).toBeTruthy();
    expect(within(truthPanel).queryByText("0 readable artifacts")).toBeNull();
  });
});
