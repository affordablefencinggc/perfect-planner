// People screen journey: first run (the first person becomes the owner), add a
// helper, change their role, share a document, and see it all again after a reload.
export const steps = [
  {
    name: "core-people-first-owner",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("people"));
      await page.expectText("See who is on this project");
      await page.expectText("Add the first person");
      await page.type({ label: "Name" }, "Riley Owner");
      await waitFor(() => page.run((h) => h.find({ label: "Person id" })?.value === "riley-owner"), { label: "person id riley-owner" });
      await page.click({ role: "button", name: "Add person" });
      await page.expectText("Riley Owner is now the owner of this project.");
      await page.expectText("Add helper");
    },
  },
  {
    name: "core-people-helper-and-role",
    run: async (page) => {
      await page.type({ label: "Name" }, "Sam Helper");
      await page.click({ role: "button", name: "Add person" });
      await page.expectText("Sam Helper was added as a helper.");
      await page.select({ label: "Role for Sam Helper" }, "viewer");
      await page.expectText("Sam Helper is now a viewer.");
    },
  },
  {
    name: "core-people-share-doc",
    run: async (page, at) => {
      await page.type({ label: "Document title" }, "Core specs");
      await page.type({ label: "Document path" }, "specs/CORE-SPECS.md");
      await page.click({ role: "button", name: "Share document" });
      await page.expectText("Core specs is now shared with everyone on the project.");
      await page.goto(at("people"));
      await page.expectText("Riley Owner");
      await page.expectText("Sam Helper");
      await page.expectText(/Core specs\s*v1/);
    },
  },
];
