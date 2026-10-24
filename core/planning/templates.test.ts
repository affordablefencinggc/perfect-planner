import { describe, expect, it } from "vitest";
import { catchDeferral } from "./catcher";
import { PACKS, findQuestion } from "./packs";
import { SIGNALS } from "./profile";
import {
  AREA_SIGNALS,
  DEPTH_TIER,
  FILE_ROLES,
  SIZE_LIMIT,
  TASK_SIZES,
  TEMPLATES,
  TEMPLATE_DEPTHS,
  TEMPLATE_IDS,
  areaHint,
  areaOrder,
  effectiveSkip,
  isTemplateId,
  skipText,
  suggestionFor,
  taskCount,
  templateById,
  templateCards,
} from "./templates";
import { AREAS } from "./types";
import type { IdeaProfile } from "./types";

const ALL_SIGNALS = Object.keys(SIGNALS);
const everything: IdeaProfile = { idea: "", signals: ALL_SIGNALS, known: {}, team: "team" };
const nothing: IdeaProfile = { idea: "", signals: [], known: {}, team: "solo" };

describe("the eight templates", () => {
  it("are the eight the owner asked for, in that order", () => {
    expect(TEMPLATES.map((t) => t.title)).toEqual([
      "New web app",
      "New command-line tool",
      "Backend service / API",
      "Library or package",
      "Add a feature to an existing app",
      "Fix a bug",
      "Clean-up / refactor",
      "Get an app ready to release",
    ]);
    expect(TEMPLATES.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
  });

  it("have a plain one-line description, a default depth and the ten areas split into first, usual and skipped", () => {
    for (const t of TEMPLATES) {
      expect(t.description.length, t.id).toBeGreaterThan(30);
      expect(t.description, t.id).not.toMatch(/\n/);
      expect(t.description, t.id).not.toContain("—");
      expect(TEMPLATE_DEPTHS).toContain(t.depth);
      expect(t.askFirst.length, t.id).toBeGreaterThan(0);
      expect(t.usuallySkip.length, t.id).toBeGreaterThan(0);
      for (const a of [...t.askFirst, ...t.usuallySkip]) expect(AREAS).toContain(a);
      expect(new Set(t.askFirst).size).toBe(t.askFirst.length);
      expect(new Set(t.usuallySkip).size).toBe(t.usuallySkip.length);
      // An area cannot be both first and skipped.
      expect(t.askFirst.filter((a) => t.usuallySkip.includes(a)), t.id).toEqual([]);
      expect(t.skipFor.length).toBeGreaterThan(3);
      expect(catchDeferral(skipText(t)).deferred, t.id).toBe(false);
    }
  });

  it("each has a skeleton of tiny tasks: no task names more than a few files", () => {
    for (const t of TEMPLATES) {
      const steps = t.skeleton.map((x) => x.step);
      expect(new Set(steps).size, `${t.id} steps are unique`).toBe(steps.length);
      expect(t.skeleton.length, t.id).toBeGreaterThanOrEqual(6);
      for (const [i, x] of t.skeleton.entries()) {
        const where = `${t.id}/${x.step}`;
        expect(x.step, where).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(TASK_SIZES, where).toContain(x.size);
        expect(x.files.length, where).toBeGreaterThanOrEqual(1);
        expect(x.files.length, where).toBeLessThanOrEqual(SIZE_LIMIT[x.size]);
        expect(x.files.length, where).toBeLessThanOrEqual(4);
        expect(new Set(x.files).size, where).toBe(x.files.length);
        for (const r of x.files) expect(FILE_ROLES, where).toContain(r);
        expect([1, 2, 3], where).toContain(x.tier);
        expect(x.title.length, where).toBeLessThanOrEqual(70);
        expect(x.doneWhen, where).toMatch(/\.$/);
        expect(x.doneWhen.length, where).toBeGreaterThan(30);
        expect(x.doneWhen.length, where).toBeLessThanOrEqual(240);
        // One sentence: no full stop followed by another sentence.
        expect(x.doneWhen, where).not.toMatch(/\.\s+\S/);
        for (const text of [x.title, x.doneWhen]) expect(text, where).not.toContain("—");
        for (const dep of x.after ?? []) {
          const at = steps.indexOf(dep);
          expect(at, `${where} comes after ${dep}`).toBeGreaterThanOrEqual(0);
          expect(at, `${where} comes after an earlier step`).toBeLessThan(i);
        }
        if (x.if?.some((c) => c.startsWith("repo:no-"))) expect(x.have, `${where} says what the repo has`).toBeTruthy();
      }
    }
  });

  it("have more tasks the deeper they go, and a sensible number at their own depth", () => {
    for (const t of TEMPLATES) {
      const counts = TEMPLATE_DEPTHS.map((d) => taskCount(t, d));
      expect(counts[0], t.id).toBeGreaterThanOrEqual(3);
      expect(counts[0]!).toBeLessThanOrEqual(counts[1]!);
      expect(counts[1]!).toBeLessThanOrEqual(counts[2]!);
      expect(counts[2]!, t.id).toBeLessThanOrEqual(14);
      expect(taskCount(t), t.id).toBe(counts[TEMPLATE_DEPTHS.indexOf(t.depth)]);
      expect(DEPTH_TIER[t.depth]).toBeGreaterThanOrEqual(1);
    }
  });

  it("suggest only real options of real questions, and never an empty or deferring answer", () => {
    for (const t of TEMPLATES) {
      expect(t.suggestions.length, t.id).toBeGreaterThanOrEqual(2);
      for (const x of t.suggestions) {
        const where = `${t.id}/${x.q}`;
        expect(Boolean(x.option) !== Boolean(x.text), `${where} has exactly one of option or text`).toBe(true);
        expect(x.why.length, where).toBeGreaterThan(10);
        expect(x.why, where).not.toContain("—");
        const q = findQuestion(everything, x.q) ?? findQuestion(nothing, x.q);
        expect(q, `${where} is a planning question`).toBeTruthy();
        if (x.option) expect(q!.options.map((o) => o.id), where).toContain(x.option);
        if (x.text) expect(catchDeferral(x.text).deferred, where).toBe(false);
        for (const s of [x.when, x.unless]) if (s) expect(ALL_SIGNALS, where).toContain(s);
      }
    }
  });

  it("list the same cards every time, without the skeleton, whatever any repo or idea says", () => {
    const first = JSON.stringify(templateCards());
    expect(JSON.stringify(templateCards())).toBe(first);
    const cards = templateCards();
    expect(cards).toHaveLength(8);
    for (const c of cards) {
      expect(Object.keys(c).sort()).toEqual(["askFirst", "depth", "description", "id", "tasks", "title", "usuallySkip"]);
      expect(c.tasks).toBeGreaterThanOrEqual(3);
    }
  });

  it("only know the eight ids: look-alikes and prototype names are not templates", () => {
    for (const id of TEMPLATE_IDS) expect(isTemplateId(id)).toBe(true);
    for (const bad of ["", "blank", "Web-App", "web-app ", "web-app\n", "__proto__", "constructor", "toString", "hasOwnProperty", "../web-app", 7, null, undefined, {}, ["web-app"]]) {
      expect(isTemplateId(bad), String(bad)).toBe(false);
      expect(templateById(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("areas and suggestions for a template", () => {
  it("puts ask-first areas first, usually skipped ones last, and every area exactly once", () => {
    for (const t of TEMPLATES) {
      const order = areaOrder(t, [], AREAS);
      expect([...order].sort()).toEqual([...AREAS].sort());
      const skip = effectiveSkip(t, []);
      expect(order.slice(0, t.askFirst.length), t.id).toEqual(t.askFirst);
      expect(order.slice(order.length - skip.length), t.id).toEqual(AREAS.filter((a) => skip.includes(a)));
      for (const a of t.askFirst) expect(areaHint(t, [], a)).toBe("ask-first");
      for (const a of skip) expect(areaHint(t, [], a)).toBe("usually-skip");
    }
  });

  it("keeps an area asked when the idea raises its signal (money for payments, AI for AI, offline for offline)", () => {
    const cli = templateById("cli-tool")!;
    expect(effectiveSkip(cli, [])).toEqual(expect.arrayContaining(["money", "ai", "offline"]));
    expect(effectiveSkip(cli, ["payments"])).not.toContain("money");
    expect(effectiveSkip(cli, ["ai"])).not.toContain("ai");
    expect(effectiveSkip(cli, ["offline"])).not.toContain("offline");
    for (const signals of Object.values(AREA_SIGNALS)) for (const s of signals) expect(ALL_SIGNALS).toContain(s);
    expect(areaHint(cli, ["payments"], "money")).toBeUndefined();
  });

  it("suggests the first matching entry, by language and signal, and 'not needed' for a skipped area", () => {
    const web = templateById("web-app")!;
    expect(suggestionFor(web, "stack.language", "stack", [], "js")).toMatchObject({ option: "typescript" });
    expect(suggestionFor(web, "stack.language", "stack", [], "python")).toMatchObject({ option: "python" });
    // "unless": the question's own recommendation covers payments when the idea takes money.
    expect(suggestionFor(web, "money.payments", "money", [], "js")).toMatchObject({ option: "not-v1" });
    expect(suggestionFor(web, "money.payments", "money", ["payments"], "js")).toBeUndefined();
    // A skipped area is suggested as not needed, in words.
    expect(suggestionFor(web, "offline.required", "offline", [], "js")).toMatchObject({ text: "Not needed for a new web app." });
    expect(suggestionFor(web, "offline.required", "offline", ["offline"], "js")).toBeUndefined();
    // Nothing for a question the template has no view on.
    expect(suggestionFor(templateById("fix-bug")!, "stack.framework", "testing", [], "js")).toBeUndefined();
    const release = templateById("release-ready")!;
    expect(suggestionFor(release, "testing.deploy", "testing", ["desktop"], "js")).toMatchObject({ option: "github-releases" });
    expect(suggestionFor(release, "testing.deploy", "testing", ["mobile"], "js")).toMatchObject({ option: "app-stores" });
    expect(suggestionFor(release, "testing.deploy", "testing", [], "js")).toMatchObject({ option: "ci-preview-prod" });
  });

  it("covers the first-asked areas of every template with at least one suggestion", () => {
    for (const t of TEMPLATES) {
      const covered = new Set(t.suggestions.map((x) => x.q.split(".")[0]));
      expect(t.askFirst.some((a) => covered.has(a)), t.id).toBe(true);
    }
  });

  it("only name question ids that exist in the packs", () => {
    const ids = new Set(PACKS.flatMap((p) => p.questions(everything).map((q) => q.id)));
    for (const t of TEMPLATES) for (const x of t.suggestions) expect(ids, `${t.id}/${x.q}`).toContain(x.q);
  });
});
