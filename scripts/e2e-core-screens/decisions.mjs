// Decisions journey: a person raises a decision, overrides with a reason,
// raises a similar one, and accepts the recommendation the offline reviewer
// draws from the first decision. Earlier steps may have left other cards, so
// every locator is scoped to this step's own questions.
const FIRST = "Which file format should the E2E exports use?";
const SECOND = "Which file format should the E2E exports archive use?";

const card = (title) => ({ css: "article", text: `~${title}` });

async function raise(page, question, options) {
  // With cards on screen the form sits behind the header button; on an empty screen it is already shown.
  const formShown = await page.run((h) => Boolean(h.find({ css: "form.decisions-ask" })));
  if (!formShown) await page.click({ role: "button", name: "Ask for a decision" });
  await page.type({ label: "Question" }, question);
  for (const [i, option] of options.entries()) await page.type({ label: `Option ${i + 1}` }, option);
  await page.click({ role: "button", name: "Raise this decision" });
  await page.expectText(question);
}

export const steps = [
  {
    name: "core-decisions-raise-and-override",
    run: async (page, at) => {
      await page.goto(at("decisions"));
      await page.expectText("Decisions");
      await raise(page, FIRST, ["CSV", "JSON"]);
      await page.expectText(/Jev is not connected|Nothing in the plan or earlier decisions/);
      await page.click({ role: "button", name: "Decide", within: card(FIRST) });
      await page.click({ role: "radio", name: "CSV", within: card(FIRST) });
      await page.type({ label: "~Why", within: card(FIRST) }, "Spreadsheets open CSV directly");
      await page.click({ role: "button", name: "Save decision", within: card(FIRST) });
      await page.expectText(/Decided \(\d+\)/);
    },
  },
  {
    name: "core-decisions-accept-recommendation",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("decisions"));
      await raise(page, SECOND, ["JSON", "CSV"]);
      await page.expectText("Offline reviewer · no model");
      await page.click({ role: "button", name: "~Accept recommendation", within: card(SECOND) });
      await waitFor(() => page.run((h, title) => !h.findAll({ css: "section.decisions-open article" }).some((a) => a.textContent.includes(title)), SECOND), { label: "second question decided" });
      await page.click({ css: "summary", text: "~Decided (" });
      await page.expectText("Accepted");
      await page.expectText("Chose something else");
      await page.expectText("Spreadsheets open CSV directly");
    },
  },
];
