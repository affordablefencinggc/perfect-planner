// People screen journey. The app's signed owner pin (kept outside every project folder) gives the project
// an owner key, so the person at this window can add themselves as the first person (the owner) and then a helper.
export const steps = [
  {
    name: "core-people-add-the-owner-then-a-helper",
    run: async (page, at) => {
      await page.goto(at("people"));
      await page.expectText("See who is on this project");
      await page.expectText("Add the first person");
      await page.type({ label: "~Name" }, "Dana Owner");
      await page.click({ role: "button", name: "Add person" });
      await page.expectText("Dana Owner");
      await page.expectText("Dana Owner is now the owner of this project.");
      await page.expectText("Add helper");
      await page.type({ label: "~Name" }, "Sam Helper");
      await page.type({ label: "~Person id" }, "sam");
      await page.click({ role: "button", name: "Add person" });
      await page.expectText("Sam Helper");
    },
  },
];
