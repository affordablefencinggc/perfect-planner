// What the work cost (core/cost): one read for the Cost panel, and the person's own prices.
import { costView, parsePrices, readPrices, writePrices } from "../../cost/index";
import { pricesFile } from "../../cost/index";
import { HttpError, type Router } from "../router";
import type { CoreProject } from "../project";

function view(project: CoreProject) {
  const board = project.service.board();
  const prices = readPrices(project.root);
  return { ...costView(project.entries(), board, prices), prices: Object.fromEntries(prices) };
}

export function registerCostRoutes(router: Router): void {
  /** GET /cost: totals for the project, each repo, task, run and model; every dollar figure says where it came from. */
  router.get("/cost", ({ project }) => view(project));

  /** POST /cost/prices { "<model>": { inputPerMillion, outputPerMillion } }: the person's prices, replacing the old list. */
  router.post("/cost/prices", ({ project, body }) => {
    const read = parsePrices(body);
    if (!read.ok) throw new HttpError(400, "INVALID", read.problem);
    try {
      writePrices(project.root, read.prices);
    } catch (error) {
      throw new HttpError(500, "WRITE_FAILED", `The prices could not be saved (${pricesFile(project.root)}): ${(error as Error).message}`);
    }
    return view(project);
  });
}
