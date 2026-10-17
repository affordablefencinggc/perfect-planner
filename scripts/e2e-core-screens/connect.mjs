// Connect agent: one click gives a command; an agent that checks in through the
// bridge (the way dist/core-host/agent.mjs does) shows as Connected right away.
const DRAWER = { css: ".connect-agent-drawer" };

export const steps = [
  {
    name: "core-connect-agent-checks-in",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("home"));
      await page.click({ css: ".topbar-connect-agent" }, "header Connect agent");
      await page.expectText("Connect an agent");
      await page.click({ within: DRAWER, role: "button", name: "Connect agent" }, "Connect agent in drawer");
      await page.expectText("Waiting for the agent to check in");
      const command = await waitFor(() => page.eval(`document.querySelector("[data-connect-command]")?.textContent ?? null`), { label: "connect command" });
      const url = /PP_BRIDGE_URL=(\S+)/.exec(command)?.[1];
      const token = /PP_AGENT_TOKEN=(\S+)/.exec(command)?.[1];
      if (!url || !token) throw new Error(`Command is missing the bridge URL or token: ${command.replace(/pp_c_\S+/, "pp_c_…")}`);
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
];
