// Reads what the person's own description already settles, so planning never
// asks "Who signs in?" of an idea that says "no accounts". Rule based and
// deterministic: fixed word lists, no model. Two kinds of finding:
//   - negatives ("no accounts", "no cloud sync", "single user", "offline
//     only", "no payments", "no AI", ...) rule a whole area out: its
//     questions are answered "not needed" and its roadmap tasks never appear;
//   - positives ("uses SQLite", "React Native", "Stripe", ...) answer one
//     question with what the person named.
// A negative always beats a positive for the same question ("No login. Magic
// link maybe one day." is no login). Each finding keeps the person's words.

/** One planning question the description answers. */
export interface DescriptionFact {
  /** Planning question id, e.g. "auth.signin". */
  id: string;
  /** Option id when the description matches one of the question's options. */
  choice?: string;
  /** The answer in words; with a choice, extra detail after the option's label. */
  text?: string;
  /** The person's words that settled it, as written in the idea. */
  phrase: string;
}

/** Something the description rules out or pins down for the whole idea. */
export interface RuledOut {
  id: "accounts" | "single-user" | "sync" | "server" | "offline-only" | "payments" | "ai" | "sharing" | "not-an-app";
  label: string;
  phrase: string;
}

export interface Description {
  facts: DescriptionFact[];
  ruledOut: RuledOut[];
}

type Flag = RuledOut["id"] | "internet";

const LABELS: Readonly<Record<RuledOut["id"], string>> = {
  accounts: "No accounts or sign-in",
  "single-user": "One person uses it",
  sync: "Nothing syncs to a cloud",
  server: "No server or backend",
  "offline-only": "Offline only",
  payments: "No payments",
  ai: "No AI",
  sharing: "No sharing between people",
  "not-an-app": "A library or command-line tool, not an app",
};

/**
 * What a library or command-line tool never has: no app framework, hosting,
 * database or sign-in. Shared by the description and the repo reader, so an
 * idea that says "library" and a package.json with a `bin` plan the same way.
 */
export const NOT_AN_APP_FACTS: readonly { id: string; choice?: string; text: string; detail?: string }[] = [
  { id: "stack.framework", text: "Not needed: no app framework" },
  { id: "stack.hosting", choice: "no-server", text: "No server" },
  { id: "data.store", choice: "none", text: "Nothing stored" },
  { id: "data.schema", text: "Not needed: nothing is stored" },
  { id: "data.migrations", text: "Not needed: nothing is stored" },
  { id: "data.backups", text: "Not needed: nothing is stored" },
  { id: "auth.signin", choice: "no-login", text: "No sign-in" },
  { id: "auth.provider", choice: "none", text: "No sign-in" },
  { id: "auth.roles", text: "Not needed: no accounts, so no roles" },
  { id: "offline.required", text: "Not needed: runs locally, nothing to sync" },
  { id: "offline.sync-engine", choice: "none", text: "No sync" },
  { id: "offline.conflicts", text: "Not needed: nothing syncs between devices" },
  { id: "scale.users", text: "Not needed: a library has no users to host" },
  { id: "scale.budget", text: "Not needed: nothing runs on a server" },
  { id: "scale.cost-watch", text: "Not needed: nothing runs on a server" },
  { id: "platforms.first", text: "Not needed: a library has no screens" },
  { id: "platforms.desktop-shell", text: "Not needed: no desktop app" },
  { id: "platforms.mobile-stack", text: "Not needed: no mobile app" },
  { id: "platforms.shared", text: "Not needed: one codebase, no app platforms" },
];

/** Also true when nothing is stored or sent anywhere: security has nothing to guard. */
export const NOTHING_LEAVES_FACTS: readonly { id: string; choice?: string; text: string; detail?: string }[] = [
  { id: "security.personal-data", choice: "store-none", text: "Not needed: nothing is stored or sent" },
  { id: "security.encryption", text: "Not needed: nothing is stored or sent" },
  { id: "security.access", text: "Not needed: nothing is stored or sent" },
  { id: "security.secrets", text: "Not needed: nothing is stored or sent" },
  { id: "ai.use", choice: "no", text: "No AI" },
  { id: "ai.model", text: "Not needed: nothing is sent anywhere" },
  { id: "ai.fallback", text: "Not needed: nothing is sent anywhere" },
  { id: "ai.cost-cap", text: "Not needed: nothing is sent anywhere" },
  { id: "money.payments", choice: "not-v1", text: "No payments" },
  { id: "money.pricing", choice: "free", text: "No payments", detail: "no payments" },
  { id: "money.tax-refunds", choice: "not-needed", text: "No payments" },
];

/** Negatable words, each tied to what it rules out. Order matters where one starts like another ("cloud sync" before "cloud"). */
const TERMS: readonly { flag: Flag; pattern: string }[] = [
  { flag: "accounts", pattern: "(?:user\\s+)?accounts?|log-?ins?|sign[- ]?ins?|sign[- ]?ups?|registration|authentication|auth|passwords?" },
  { flag: "sync", pattern: "(?:cloud\\s+)?(?:sync(?:ing|ed)?|synchroni[sz]ation)" },
  { flag: "server", pattern: "back-?ends?|servers?|cloud(?:\\s+(?:storage|backend|server))?|hosting" },
  { flag: "payments", pattern: "payments?|billing|subscriptions?|in-?app\\s+purchases?|paywalls?|charges?" },
  { flag: "ai", pattern: "ai|a\\.i\\.|llms?|machine\\s+learning|chatbots?" },
  { flag: "sharing", pattern: "sharing|collaboration|multi-?user|multiple\\s+users|other\\s+users|teams?" },
  { flag: "internet", pattern: "internet(?:\\s+connection)?|network\\s+connection|connection|wi-?fi|network(?:\\s+(?:access|calls?|requests?))?" },
];

const NEG = "(?:no|without(?:\\s+any)?|zero|(?:doesn'?t|does\\s+not|don'?t|do\\s+not|won'?t|will\\s+not|never)\\s+(?:need|have|use|require|take|support)s?(?:\\s+any)?)";
const TERM = `(?:${TERMS.map((t) => t.pattern).join("|")})`;
const SEP = "(?:\\s*,\\s*(?:or\\s+|and\\s+|nor\\s+)?|\\s+(?:or|and|nor)\\s+|\\s*\\/\\s*)";
/** "no accounts, no login or cloud sync": one negation, then a list of negatable words. */
const NEGATED_LIST = new RegExp(`\\b(${NEG})\\s+(${TERM}\\b(?:${SEP}(?:no\\s+)?${TERM}\\b)*)`, "gi");
const ITEM = new RegExp(`\\b(?:no\\s+)?(${TERM})\\b`, "gi");

const SINGLE_USER = /\b(?:single[- ]user|one[- ]user|(?:for\s+)?(?:only\s+)?one\s+person|just\s+(?:for\s+)?me|only\s+(?:for\s+)?me|for\s+my\s+own\s+use|personal\s+use)\b/i;
const OFFLINE_ONLY = /\b(?:offline[- ]only|only\s+(?:works\s+)?offline|fully\s+offline|entirely\s+offline)\b/i;
const WORKS_OFFLINE = /\b(?:works?|working|usable|runs?)\s+offline\b|\boffline[- ]first\b/i;
/** Last word of what is being built that makes it a library or tool rather than an app. */
const BUILT_LIBRARY = /^(?:librar(?:y|ies)|lib|(?:npm |python |node |js |ts )?(?:package|module)|cli|sdk|(?:cli|command[- ]line|terminal|shell)\s+(?:tool|app|utility|program|script)|command[- ]line|utility|script)$/i;
/** Where the description of the thing ends and what it is for begins. */
const HEAD_END = /\s+(?:for|that|which|where|with|to|so|in|on|of|using|when|and|but|used|built|written|from|by|like)\b|[,.:;!?\u2014]|\s-\s/i;
/** Words that show an app, whatever else the idea says: a person signing in, a server, a screen. */
const APP_WORDS = /\b(?:sign[- ]?in|log[- ]?in|accounts?|users?|apps?|web\s?(?:site|app)|websites?|dashboards?|mobile|ios|android|database|server|backend|hosted|saas|stripe|payments?|billing|subscriptions?|share[sd]?|families|teams?)\b/i;
const LOCAL_ONLY = /\b(?:local[- ]only|(?:on[- ])?device[- ]only)\b/i;

interface Positive {
  id: string;
  pattern: RegExp;
  choice?: string;
  text?: string;
}

/** What the person names, in priority order per question (the first match wins). */
const POSITIVES: readonly Positive[] = [
  { id: "stack.language", pattern: /\btypescript\b/i, choice: "typescript" },
  { id: "stack.language", pattern: /\bpython\b/i, choice: "python" },
  { id: "stack.language", pattern: /\bgolang\b|\bgo\s+(?:backend|server)\b/i, choice: "go" },
  { id: "stack.framework", pattern: /\bnext\.?js\b/i, choice: "nextjs" },
  { id: "stack.framework", pattern: /\bsvelte\s?kit\b/i, choice: "sveltekit" },
  { id: "stack.framework", pattern: /\bvite\b/i, choice: "vite-react" },
  { id: "stack.framework", pattern: /\breact\b(?![\s-]*native)/i, text: "React" },
  { id: "stack.hosting", pattern: /\bvercel\b/i, choice: "vercel" },
  { id: "stack.hosting", pattern: /\bfly\.io\b/i, choice: "fly-io" },
  { id: "stack.hosting", pattern: /\bcloudflare\b/i, choice: "cloudflare" },
  { id: "data.store", pattern: /\bsupabase\b/i, choice: "postgres", text: "Supabase (Postgres)" },
  { id: "data.store", pattern: /\bpostgres(?:ql)?\b/i, choice: "postgres" },
  { id: "data.store", pattern: /\bmysql\b/i, text: "MySQL" },
  { id: "data.store", pattern: /\bmongo(?:db)?\b/i, text: "MongoDB" },
  { id: "data.store", pattern: /\bfirebase\b|\bfirestore\b/i, text: "Firebase" },
  { id: "data.store", pattern: /\bindexeddb\b/i, text: "IndexedDB in the browser" },
  { id: "data.schema", pattern: /\bprisma\b/i, choice: "prisma" },
  { id: "data.schema", pattern: /\bdrizzle\b/i, choice: "drizzle" },
  { id: "auth.signin", pattern: /\bmagic[- ]links?\b/i, choice: "magic-link" },
  { id: "auth.signin", pattern: /\b(?:google|github|apple)\s+(?:sign[- ]?in|log-?in|accounts?)\b|\bsign\s+in\s+with\s+(?:google|github|apple)\b|\boauth\b/i, choice: "oauth" },
  { id: "auth.signin", pattern: /\b(?:email|username)\s+(?:and|\+|&)\s+passwords?\b/i, choice: "passwords" },
  { id: "auth.provider", pattern: /\bclerk\b/i, choice: "clerk" },
  { id: "auth.provider", pattern: /\bauth\.?js\b|\bnext-?auth\b/i, choice: "authjs" },
  { id: "auth.provider", pattern: /\bsupabase\s+auth\b/i, choice: "supabase-auth" },
  { id: "money.payments", pattern: /\bstripe\b/i, choice: "stripe-checkout" },
  { id: "money.payments", pattern: /\bpaddle\b|\blemon\s?squeezy\b/i, choice: "merchant-of-record" },
  { id: "money.pricing", pattern: /\bone[- ]time\s+(?:purchase|payment|fee)\b/i, choice: "one-time" },
  { id: "money.pricing", pattern: /\busage[- ]based\b|\bpay[- ]per[- ]use\b/i, choice: "usage" },
  { id: "money.pricing", pattern: /\bsubscriptions?\b|\bmonthly\s+(?:plan|fee)\b/i, choice: "subscription" },
  { id: "platforms.desktop-shell", pattern: /\btauri\b/i, choice: "tauri" },
  { id: "platforms.desktop-shell", pattern: /\belectron\b/i, choice: "electron" },
  { id: "platforms.mobile-stack", pattern: /\bexpo\b/i, choice: "expo" },
  { id: "platforms.mobile-stack", pattern: /\breact[\s-]*native\b/i, text: "React Native" },
  { id: "platforms.mobile-stack", pattern: /\bflutter\b/i, text: "Flutter" },
  { id: "platforms.mobile-stack", pattern: /\bswift(?:ui)?\b|\bkotlin\b/i, choice: "native" },
  { id: "platforms.mobile-stack", pattern: /\bpwa\b|\bprogressive\s+web\s+app\b|\binstallable\s+web\s+app\b/i, choice: "pwa" },
];

/** Signals a description adds on top of the keyword scan. */
export const POSITIVE_SIGNALS: readonly { signal: string; pattern: RegExp }[] = [
  { signal: "mobile", pattern: /\breact[\s-]*native\b|\bexpo\b|\bflutter\b/i },
  { signal: "desktop", pattern: /\btauri\b|\belectron\b/i },
];

interface Negation {
  flag: Flag;
  start: number;
  end: number;
  phrase: string;
}

/** Every negated word in the idea, with its span and the person's words for it. */
function negations(idea: string): Negation[] {
  const out: Negation[] = [];
  for (const list of idea.matchAll(NEGATED_LIST)) {
    const neg = list[1]!;
    const listStart = list.index! + list[0].indexOf(list[2]!, neg.length);
    const items: { flag: Flag; start: number; end: number; own: boolean }[] = [];
    for (const item of list[2]!.matchAll(ITEM)) {
      const word = item[1]!;
      const flag = TERMS.find((t) => new RegExp(`^(?:${t.pattern})$`, "i").test(word))?.flag;
      if (!flag) continue;
      items.push({ flag, start: listStart + item.index!, end: listStart + item.index! + item[0].length, own: /^no\s/i.test(item[0]) });
    }
    for (const flag of new Set(items.map((i) => i.flag))) {
      const mine = items.filter((i) => i.flag === flag);
      const first = mine[0]!;
      const from = first === items[0] ? list.index! : first.start;
      const text = idea.slice(from, mine.at(-1)!.end);
      out.push({ flag, start: list.index!, end: list.index! + list[0].length, phrase: first === items[0] || first.own ? text : `${neg} ${text}` });
    }
  }
  return out;
}

function phraseOf(match: RegExpMatchArray | null): string | undefined {
  return match ? match[0] : undefined;
}

/** The idea with every negated list blanked out, so "no cloud sync" does not raise the offline signal. */
export function withoutNegations(idea: string): string {
  return idea.replace(NEGATED_LIST, (m) => " ".repeat(m.length));
}

/** True when the idea names something only an app has (sign in, accounts, users, a website, a server). */
export function mentionsApp(idea: string): boolean {
  return APP_WORDS.test(withoutNegations(idea));
}

/**
 * The words that say the thing being built is a library or tool ("A tiny
 * slugify library", "a CLI that renames photos"), or undefined. Only the head
 * of the idea or of what follows "build/make/write/create" counts, and its
 * last word must be the library word, so "a photo library app" and "library
 * management system" are apps. Any app word anywhere ("sign in", "accounts",
 * "users", "web") wins over it.
 */
export function libraryPhrase(raw: string): string | undefined {
  const idea = withoutNegations(raw);
  if (APP_WORDS.test(idea)) return undefined;
  const starts = [0, ...[...idea.matchAll(/\b(?:build|make|write|create|ship|publish)(?:ing)?\s+/gi)].map((m) => m.index! + m[0].length)];
  for (const at of starts) {
    const rest = idea.slice(at).replace(/^\s*(?:an?|the|my|our|some)\s+/i, "");
    const head = rest.split(HEAD_END)[0]!.trim();
    const words = head.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 6) continue;
    for (const n of [1, 2, 3]) {
      const t = words.slice(-n).join(" ");
      if (words.length >= n && BUILT_LIBRARY.test(t)) return head;
    }
  }
  return undefined;
}

/** What the description settles and rules out. Pure; the same idea always gives the same answer. */
export function readDescription(idea: string): Description {
  const text = String(idea ?? "");
  const negated = negations(text);
  const said = new Map<Flag, string>();
  for (const n of negated) if (!said.has(n.flag)) said.set(n.flag, n.phrase);
  const single = phraseOf(text.match(SINGLE_USER));
  if (single) said.set("single-user", single);
  const offlineOnly = phraseOf(text.match(OFFLINE_ONLY));
  if (offlineOnly) said.set("offline-only", offlineOnly);
  const local = phraseOf(text.match(LOCAL_ONLY));
  if (local && !said.has("server")) said.set("server", local);

  const plain = withoutNegations(text);
  const positives: DescriptionFact[] = [];
  for (const p of POSITIVES) {
    if (positives.some((f) => f.id === p.id)) continue;
    const m = plain.match(p.pattern);
    if (m) positives.push({ id: p.id, ...(p.choice ? { choice: p.choice } : {}), ...(p.text ? { text: p.text } : {}), phrase: m[0] });
  }

  const negatives: DescriptionFact[] = [];
  const settle = (phrase: string, facts: Omit<DescriptionFact, "phrase">[]): void => {
    for (const f of facts) if (!negatives.some((n) => n.id === f.id)) negatives.push({ ...f, phrase });
  };
  const notNeeded = (why: string) => `Not needed: ${why}`;
  const signInStated = positives.some((f) => f.id === "auth.signin" || f.id === "auth.provider");

  const accounts = said.get("accounts") ?? (signInStated ? undefined : said.get("single-user"));
  if (accounts) {
    settle(accounts, [
      { id: "auth.signin", choice: "no-login" },
      { id: "auth.provider", choice: "none" },
      { id: "auth.roles", text: notNeeded("no accounts, so no roles") },
    ]);
  }
  const noSync = said.get("sync") ?? said.get("offline-only") ?? said.get("server");
  const offline = said.get("offline-only") ?? said.get("internet") ?? phraseOf(plain.match(WORKS_OFFLINE));
  if (offline) {
    settle(offline, [{ id: "offline.required", text: noSync ? "Works offline on the device; nothing syncs" : "Works offline" }]);
  }
  if (noSync) {
    settle(noSync, [
      { id: "offline.sync-engine", choice: "none" },
      { id: "offline.conflicts", text: notNeeded("nothing syncs between devices") },
    ]);
  }
  const server = said.get("server");
  if (server) settle(server, [{ id: "stack.hosting", choice: "no-server" }]);
  const payments = said.get("payments");
  if (payments) {
    settle(payments, [
      { id: "money.payments", choice: "not-v1" },
      { id: "money.pricing", choice: "free", text: "no payments in v1" },
      { id: "money.tax-refunds", choice: "not-needed" },
    ]);
  }
  const ai = said.get("ai");
  if (ai) {
    settle(ai, [
      { id: "ai.use", choice: "no" },
      { id: "ai.model", text: notNeeded("no AI in v1") },
      { id: "ai.fallback", text: notNeeded("no AI in v1") },
      { id: "ai.cost-cap", text: notNeeded("no AI in v1") },
    ]);
  }

  // SQLite is local when nothing leaves the device, synced when the idea says offline and does not rule sync out.
  const sqlite = plain.match(/\bsqlite\b/i);
  if (sqlite && !positives.some((f) => f.id === "data.store")) {
    const choice = noSync || said.has("single-user") ? "sqlite-local" : offline ? "sqlite-sync" : undefined;
    positives.push({ id: "data.store", ...(choice ? { choice } : { text: "SQLite" }), phrase: sqlite[0] });
  }

  const facts = [...negatives, ...positives.filter((p) => !negatives.some((n) => n.id === p.id))];
  // A library or command-line tool has no app parts. What the person named or ruled out above wins.
  const library = libraryPhrase(plain);
  if (library) {
    said.set("not-an-app", library);
    const quiet = said.has("server") || said.has("sync") || said.has("offline-only") || said.has("internet");
    for (const f of [...NOT_AN_APP_FACTS, ...(quiet ? NOTHING_LEAVES_FACTS : [])]) {
      if (facts.some((x) => x.id === f.id)) continue;
      facts.push({ id: f.id, ...(f.choice ? { choice: f.choice, ...(f.detail ? { text: f.detail } : {}) } : { text: f.text }), phrase: library });
    }
  }
  const ruledOut: RuledOut[] = (Object.keys(LABELS) as RuledOut["id"][])
    .filter((id) => said.has(id))
    .map((id) => ({ id, label: LABELS[id], phrase: said.get(id)! }));
  return { facts, ruledOut };
}

/** Signals the description takes away (it rules them out) and adds (it names them). */
export function descriptionSignals(idea: string): { remove: string[]; add: string[] } {
  const { ruledOut, facts } = readDescription(idea);
  const out = new Set(ruledOut.map((r) => r.id));
  const remove: string[] = [];
  if (out.has("payments")) remove.push("payments");
  if (out.has("ai")) remove.push("ai");
  if (out.has("single-user") || out.has("sharing")) remove.push("team");
  if (out.has("sync") || out.has("server")) remove.push("offline");
  const add: string[] = [];
  if (facts.some((f) => f.id === "offline.required") && !remove.includes("offline")) add.push("offline");
  for (const s of POSITIVE_SIGNALS) if (s.pattern.test(withoutNegations(idea))) add.push(s.signal);
  return { remove, add };
}
