// MVP board journey: plan a new project, move a feature out of the MVP with a
// reason, confirm the line, and see it survive a reload.
export const steps = [
  {
    name: "core-mvp-plan-new-project",
    run: async (page, at) => {
      await page.goto(at("mvp"));
      await page.expectText("Plan a new project");
      await page.type({ label: "~What is the project for? (one line)" }, "Write a note and share it");
      await page.type({ label: "~Features, one per line" }, "Note editor (needs: Note store)\nNote store\nShare notes with a team\nPerformance budget gate");
      await page.click({ role: "button", name: "Plan a new project" });
      await page.expectText("Proposed MVP line — confirm or move features across");
      await page.expectText("came from the offline advisor");
      await page.expectText("Note editor");
    },
  },
  {
    name: "core-mvp-move-later-with-reason",
    run: async (page, at, { re }) => {
      await page.click({ role: "button", name: "Move Share notes with a team later" });
      await page.type({ label: "~Why can it wait?" }, "Sharing can follow once writing works");
      await page.click({ role: "button", name: "Move" });
      await page.expectText(new RegExp("Moved Share notes with a team to Beta", "i"));
      await page.expectText("Why later: Sharing can follow once writing works");
    },
  },
  {
    name: "core-mvp-confirm-line",
    run: async (page, at, { re }) => {
      await page.click({ role: "button", name: "Confirm MVP line" });
      await page.expectText(new RegExp("Confirmed by .+ on", "i"));
      await page.expectText("When is the MVP done?");
      await page.reload();
      await page.expectText(new RegExp("Confirmed by .+ on", "i"));
      await page.expectText("Why later: Sharing can follow once writing works");
    },
  },
];
