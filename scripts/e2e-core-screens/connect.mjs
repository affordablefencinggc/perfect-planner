// Connect agent: one click gives a command; an agent that checks in through the
// bridge (the way dist/core-host/agent.mjs does) shows as Connected right away.
const DRAWER = { css: ".connect-agent-drawer" };

export const steps = [
  {
    // Nothing is written to a project until its person starts its history (a person-only action, never a connect step).
    // Earlier journey steps may have started it already, so click only when the notice is still offered.
    name: "core-connect-start-history",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("planning"));
      const offered = await waitFor(() => page.eval(`document.body.innerText.includes("Start a new history for this folder") ? "offer" : document.body.innerText.includes("Start with your idea") ? "started" : null`), { label: "planning screen" });
      if (offered === "offer") await page.click({ role: "button", name: "Start a new history for this folder" }, "Start a new history");
      await page.expectText("Start with your idea");
    },
  },
  {
    name: "core-connect-agent-checks-in",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("home"));
      await page.click({ css: ".topbar-connect-agent" }, "header Connect agent");
      await page.expectText("Connect an agent");
      await page.click({ within: DRAWER, role: "button", name: "Connect agent" }, "Connect agent in drawer");
      await page.expectText("Waiting for the agent to check in");
      const command = await waitFor(() => page.eval(`document.querySelector("[data-connect-command]")?.textContent ?? null`), { label: "connect command" });
      const url = /\s(http:\/\/\S+)\s/.exec(command)?.[1];
      const tokenFile = /\s'([^']+\.token)'$/.exec(command.trim())?.[1];
      if (/pp_[cw]_/.test(command)) throw new Error("The connect line carries a key; it must name the token file instead.");
      const token = tokenFile ? (await import("node:fs")).readFileSync(tokenFile, "utf8").trim() : null;
      if (!url || !token) throw new Error(`Command is missing the bridge URL or token: ${command}`);
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`Bridge is not on loopback: ${url}`);
      const res = await fetch(`${url}/call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "hello", args: { name: "E2E Agent", model: "e2e-model" } }),
      });
      const body = await res.json();
      if (!body.ok || body.result.role !== "main") throw new Error(`hello did not make the main chat: ${JSON.stringify(body)}`);
      await page.expectText("Connected: E2E Agent (e2e-model, self-reported) is your main chat.");
      const leaked = await page.eval(`document.body.innerText.includes(${JSON.stringify(token)}) || Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(${JSON.stringify(token)}))`);
      if (leaked) throw new Error("The token is still on the page or in localStorage after the agent checked in.");
      await page.click({ within: DRAWER, role: "button", name: "Close" }, "close drawer");
    },
  },
  {
    // The same one line for the other agent CLIs: the picker changes only --agent; no key is ever in the line.
    name: "core-connect-agent-line-per-agent",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("home"));
      await page.click({ css: ".topbar-connect-agent" }, "header Connect agent");
      await page.click({ within: DRAWER, role: "button", name: "Connect agent" }, "Connect agent in drawer");
      const lineFor = (agent) => waitFor(() => page.eval(`(() => { const c = document.querySelector("[data-connect-command]")?.textContent ?? ""; return c.includes(${JSON.stringify(`--agent ${agent} `)}) ? c : null; })()`), { label: `${agent} connect line` });
      for (const [label, agent] of [["Gemini CLI", "gemini"], ["Codex CLI", "codex"], ["Claude Code", "claude"]]) {
        await page.click({ within: DRAWER, role: "radio", name: label }, `pick ${label}`);
        const command = await lineFor(agent);
        if (/pp_[cw]_/.test(command)) throw new Error(`The ${label} line carries a key; it must name the token file instead.`);
        if (!/\.token'$/.test(command.trim()) || command.includes("\n")) throw new Error(`The ${label} line is not one line ending in a token file: ${command}`);
        await page.expectText(`${label} command`);
      }
      await page.click({ within: DRAWER, role: "button", name: "Close" }, "close drawer");
    },
  },
];
