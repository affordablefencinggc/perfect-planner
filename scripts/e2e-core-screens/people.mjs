// People screen journey. Until the app's signed owner pin is in (#25, kept outside every project
// folder), this build has no owner key for a project, so the people rules let nobody start the
// roster. The screen must say that plainly and must not offer "Add the first person".
// The add-helper / change-role / share-document steps come back with the pin.
export const steps = [
  {
    name: "core-people-says-owner-key-missing",
    run: async (page, at) => {
      await page.goto(at("people"));
      await page.expectText("See who is on this project");
      await page.expectText("does not have this project's owner key");
      const text = await page.text();
      const offered = text.includes("Add the first person") || text.includes("Add person");
      if (offered) throw new Error("People offers to add a first person although nobody can be added without an owner key");
    },
  },
];
