// Ledger search journey: the screen shows the chain status and recent entries,
// an exact reference opens its detail card, and the header box ("/" then Enter)
// hands a reference over to the screen. Earlier steps may already have written
// entries, so each check accepts both an empty and a filled ledger.
const enter = async (page) => {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  }
  await page.settle(300);
};

export const steps = [
  {
    name: "core-lookup-screen",
    run: async (page, at) => {
      await page.goto(at("lookup"));
      await page.expectText("Ledger search");
      await page.expectText(/Ledger intact · \d+ (entry|entries)/);
      await page.expectText(/Latest on the ledger|The ledger has no entries yet\./);
      await page.type({ label: "Reference or words to find" }, "L-1");
      await page.click({ role: "button", name: "Search" });
      await page.expectText(/Ledger entry 1\b|L-000001 does not exist/);
      await page.click({ role: "button", name: "Back to recent entries" });
      await page.expectText(/Latest on the ledger|The ledger has no entries yet\./);
    },
  },
  {
    name: "core-lookup-header-box",
    run: async (page, at, { waitFor }) => {
      await page.goto(at("home"));
      await page.eval("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "/", code: "Slash", text: "/", windowsVirtualKeyCode: 191 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash", windowsVirtualKeyCode: 191 });
      await waitFor(() => page.eval("document.activeElement?.getAttribute('aria-label') === 'Find a plan clause, release, task or ledger entry'"), { label: "/ focuses the header search box" });
      await page.send("Input.insertText", { text: "R-1" });
      await enter(page);
      await page.expectText("Find any plan clause, task, question, decision, release or ledger entry");
      await page.expectText(/Release R-1|R-1 was never released/);
    },
  },
];
