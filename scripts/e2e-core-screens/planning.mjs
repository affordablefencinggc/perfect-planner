// Deep planning journey: idea -> questions -> a refused "TBD" -> a refused approval ->
// every blocker settled by its recommendation -> approval -> mind map and roadmap.
const IDEA = "Desktop invoice app with Stripe payments that works offline";
// The Plan page step before this one already recorded an approval in the project ledger, so this screen
// offers "Approve changed plan" until the plan is approved again as it now stands.
const APPROVE = { role: "button", name: { re: "^Approve (changed )?plan$", flags: "i" } };

export const steps = [
  {
    name: "core-planning-start-from-idea",
    run: async (page, at) => {
      await page.goto(at("planning"));
      await page.expectText("Start with your idea");
      await page.expectText(/Live web research is off/);
      await page.type({ label: "~Your idea" }, IDEA);
      await page.click({ role: "button", name: "Start planning" });
      await page.expectText("Open blocking questions");
      await page.expectText(/questions answered/);
      await page.expectText("Use recommendation");
    },
  },
  {
    name: "core-planning-refuses-tbd-and-early-approval",
    run: async (page) => {
      await page.type({ label: "~Your own answer" }, "TBD");
      await page.click({ role: "button", name: "Save answer" });
      await page.expectText(/"TBD" puts Q-\d+ off/);
      await page.expectText("Set a dated spike");
      await page.click(APPROVE);
      await page.expectText(/cannot be approved yet: \d+ blocking questions? (is|are) still open/);
    },
  },
  {
    name: "core-planning-settle-blockers-and-approve",
    run: async (page, _at, { waitFor }) => {
      for (let i = 0; i < 60; i++) {
        const next = await page.run((h) => {
          const rail = h.find({ role: "region", name: "Open blocking questions" });
          return rail ? h.norm(rail.querySelector(".planning-rail-text")?.textContent) : null;
        });
        if (!next) break;
        await page.click({ role: "button", name: "Use recommendation", within: { role: "article", name: next } }, `Use recommendation for "${next}"`);
        await waitFor(() => page.run((h, text) => !h.findAll({ role: "region", name: "Open blocking questions" }).some((r) => h.norm(r.textContent).includes(text)), next), { label: `blocker "${next}" settled` });
      }
      await page.expectText("No blocking questions are open.");
      await page.click(APPROVE);
      await page.expectText(/Plan approved\. \d+ roadmap tasks were added\./);
    },
  },
  {
    name: "core-planning-mind-map-and-roadmap",
    run: async (page) => {
      await page.click({ role: "tab", name: "Mind map" });
      await page.expectText("Desktop invoice app");
      await page.expectText(/Part/);
      await page.click({ role: "tab", name: "Roadmap" });
      await page.expectText("Foundation");
      await page.expectText("Cut the first release");
      await page.expectText("These tasks are on the board");
    },
  },
];
