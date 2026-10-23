// Cost of one ledger append as the ledger grows (ledger 10-soak area 5). PP_SOAK=1. Prints ms per append at each size.
import { describe, expect, it } from "vitest";
import { asPersonRequest } from "../host/keys";
import { appendNumbered } from "../numbering/index";
import { startTestHost } from "../host/testing";

const d = process.env.PP_SOAK === "1" ? describe : describe.skip;
d("append cost by ledger size", () => {
  // FOUND (F6): a person-signed append re-verifies the signature of every person entry in the ledger (ownerChain -> selfSigned), so it grows with the ledger.
  it.fails("one append does not get slower in proportion to the ledger", async () => {
    const ctx = await startTestHost();
    try {
      const project = ctx.host.project("grow");
      const person = { kind: "person" as const, id: "owner" };
      asPersonRequest(() => appendNumbered(project.ledger, { actor: person, type: "task.created", summary: "T", data: { title: "T" } }));
      let total = 1;
      const per: number[] = [];
      for (const target of [250, 1500]) {
        while (total < target - 50) {
          asPersonRequest(() => project.ledger.append({ actor: person, type: "task.progress", subject: "T-1", summary: `n ${total}`, data: { n: total } }));
          total++;
        }
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) {
          asPersonRequest(() => project.ledger.append({ actor: person, type: "task.progress", subject: "T-1", summary: `n ${total}`, data: { n: total } }));
          total++;
        }
        const ms = (performance.now() - t0) / 50;
        per.push(ms);
        console.log(`appendcost: ${total} entries: ${ms.toFixed(2)} ms per append`);
      }
      expect(per.at(-1)!, `append at 1500 entries (${per.at(-1)!.toFixed(1)} ms) is more than 5x append at 250 (${per[0]!.toFixed(1)} ms)`).toBeLessThan(per[0]! * 5 + 5);
    } finally {
      await ctx.stop();
    }
  }, 1_200_000);
});
