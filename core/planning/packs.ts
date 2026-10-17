// Question packs: one per planning area, asked before any code is written.
// Each pack builds its questions from the profile, so recommendations follow the idea's signals.
import { AREAS, AREA_TITLES } from "./types";
import type { Area, IdeaProfile, PlanningQuestion, QuestionOption, QuestionPack, Recommendation } from "./types";

const has = (p: IdeaProfile, signal: string): boolean => p.signals.includes(signal);

const opt = (id: string, label: string, fit: string, cost?: string): QuestionOption =>
  cost === undefined ? { id, label, fit } : { id, label, fit, cost };

const rec = (option: string, reason: string, confidence: number): Recommendation => ({ option, reason, confidence });

type Spec = Omit<PlanningQuestion, "area">;

function pack(area: Area, build: (p: IdeaProfile) => Spec[]): QuestionPack {
  return {
    area,
    title: AREA_TITLES[area],
    questions: (p) => build(p).map((q) => ({ ...q, area })),
  };
}

// ---------- Stack ----------

const stack = pack("stack", (p) => {
  const web = has(p, "web");
  const desktop = has(p, "desktop");
  const mobile = has(p, "mobile");
  const anyPlatform = web || desktop || mobile;
  return [
    {
      id: "stack.language",
      text: "Which language runs the app, and why this one over the next best?",
      why: "Every later choice (framework, libraries, hiring helpers) follows the language.",
      blocking: true,
      options: [
        opt("typescript", "TypeScript everywhere", "One language for UI, server and desktop or mobile shells."),
        opt("python", "Python backend", "Heavy data or ML work on the server, with a separate UI."),
        opt("go", "Go backend", "A small, fast server or CLI with few moving parts."),
      ],
      recommendation: anyPlatform
        ? rec("typescript", "UI work on web, desktop or mobile is easiest when the whole app shares TypeScript.", 0.75)
        : has(p, "ai")
          ? rec("typescript", "Both TypeScript and Python have good AI SDKs; TypeScript keeps the UI in the same language.", 0.55)
          : rec("typescript", "No platform signal yet; TypeScript is the broadest default.", 0.5),
      research: "TypeScript vs Python vs Go for a new app backend and UI in 2026",
    },
    {
      id: "stack.framework",
      text: "Which UI framework?",
      why: "Routing, rendering and the build tool are hard to swap once screens exist.",
      blocking: false,
      options: [
        opt("nextjs", "Next.js", "A web app with server rendering and API routes in one place."),
        opt("vite-react", "Vite + React", "A client app, or the front end inside a desktop or mobile shell."),
        opt("sveltekit", "SvelteKit", "A smaller web app where bundle size matters."),
      ],
      recommendation: desktop && !web
        ? rec("vite-react", "A desktop shell wants a plain client bundle, which Vite builds fast.", 0.7)
        : web
          ? rec("nextjs", "A web app gets routing, server rendering and API routes in one framework.", 0.65)
          : rec("nextjs", "No clear platform yet; Next.js covers the most ground.", 0.45),
      research: "Next.js vs Vite React vs SvelteKit comparison 2026",
    },
    {
      id: "stack.hosting",
      text: "Where does the server side run?",
      why: "Hosting sets cost, cold starts and what databases are close by.",
      blocking: false,
      options: [
        opt("vercel", "Vercel", "Web apps on Next.js with little ops work.", "free to $20/mo"),
        opt("fly-io", "Fly.io", "Long running servers or websockets close to users.", "$5 to $30/mo"),
        opt("cloudflare", "Cloudflare Workers", "Edge functions with a generous free tier.", "free to $5/mo"),
        opt("no-server", "No server", "Everything runs on the user's device."),
      ],
      recommendation: desktop && !web && p.team === "solo" && !has(p, "offline")
        ? rec("no-server", "A solo desktop app with no sync can ship without any server.", 0.6)
        : has(p, "realtime")
          ? rec("fly-io", "Live features need long lived connections, which serverless hosts handle poorly.", 0.6)
          : web
            ? rec("vercel", "A web app ships fastest on a managed host.", 0.6)
            : rec("vercel", "No hosting signal; a managed host is the cheapest start.", 0.45),
      research: "Vercel vs Fly.io vs Cloudflare Workers pricing and limits",
    },
  ];
});

// ---------- Data ----------

const data = pack("data", (p) => {
  const offline = has(p, "offline");
  const sensitive = has(p, "personal-data") || has(p, "payments");
  return [
    {
      id: "data.store",
      text: "Where does data live?",
      why: "The store decides sync, backups and what can run offline; moving later means a migration of every record.",
      blocking: true,
      options: [
        opt("postgres", "Hosted Postgres", "Shared data, many users, one source of truth on a server.", "free to $25/mo"),
        opt("sqlite-sync", "Local-first SQLite with sync", "Must work offline, syncing to a server when online.", "$0 to $20/mo"),
        opt("sqlite-local", "Local SQLite only", "One person, one device, no sharing."),
        opt("none", "Nothing stored", "A library or command-line tool that keeps no data of its own."),
      ],
      recommendation: offline
        ? rec("sqlite-sync", "It must work offline, so data lives on the device and syncs when there is a connection.", 0.8)
        : has(p, "desktop") && p.team === "solo" && !has(p, "web")
          ? rec("sqlite-local", "A solo desktop app can keep everything in one local file.", 0.6)
          : has(p, "web") || p.team === "team"
            ? rec("postgres", "Several people or a web app need one shared store on a server.", 0.7)
            : rec("postgres", "No data signal; hosted Postgres is the safe default.", 0.5),
      research: "Postgres vs local-first SQLite sync (PowerSync, ElectricSQL) for small apps",
    },
    {
      id: "data.schema",
      text: "How is the schema written and changed?",
      why: "Without a single schema source, migrations drift between machines.",
      blocking: false,
      options: [
        opt("drizzle", "Drizzle schema in TypeScript", "Typed schema with generated SQL migrations."),
        opt("prisma", "Prisma schema", "A larger team that wants a schema file and a client generator."),
        opt("raw-sql", "Plain SQL migration files", "Full control and no ORM."),
      ],
      recommendation: rec("drizzle", "Typed schema and plain SQL migrations, works for Postgres and SQLite.", 0.55),
      research: "Drizzle vs Prisma vs raw SQL migrations 2026",
    },
    {
      id: "data.migrations",
      text: "How do migrations run in each environment?",
      why: "A migration that runs by hand in production is the usual cause of lost data.",
      blocking: false,
      options: [
        opt("forward-only", "Forward-only, run on deploy", "Each migration is checked in and runs once in CI or on startup."),
        opt("push-dev", "Schema push in dev, migrations in prod", "Fast iteration early, strict files once live."),
        opt("manual", "Run by hand", "Very small apps with one environment."),
      ],
      recommendation: offline
        ? rec("forward-only", "Every device runs the same migrations on startup, so they must be ordered and forward-only.", 0.7)
        : rec("forward-only", "Checked in migrations that run on deploy are the safest default.", 0.55),
    },
    {
      id: "data.backups",
      text: "How are backups taken and restored?",
      why: "A backup nobody has restored is a guess.",
      blocking: sensitive,
      options: [
        opt("managed-daily", "Managed daily backups", "Hosted database with point in time restore.", "often included"),
        opt("nightly-export", "Nightly export to storage", "Self-hosted or local data copied to cloud storage.", "under $1/mo"),
        opt("none-v1", "None in v1", "Throwaway or demo data only."),
      ],
      recommendation: sensitive
        ? rec("managed-daily", "Customer or payment data must survive a bad deploy.", 0.75)
        : has(p, "desktop") && p.team === "solo" && !offline && !has(p, "web")
          ? rec("nightly-export", "A local file can be copied to cloud storage each night.", 0.55)
          : rec("managed-daily", "A managed host gives backups for little effort.", 0.5),
    },
  ];
});

// ---------- Users and auth ----------

const auth = pack("auth", (p) => {
  const team = p.team === "team";
  const localOnly = has(p, "desktop") && !has(p, "web") && !team && !has(p, "offline");
  return [
    {
      id: "auth.signin",
      text: "Who signs in, and how?",
      why: "Every table needs an owner column once users exist; adding sign-in later touches every query.",
      blocking: true,
      options: [
        opt("no-login", "No sign-in", "One person on their own device."),
        opt("magic-link", "Email magic link", "Low friction, no passwords to store."),
        opt("oauth", "Google or GitHub sign-in", "Users already have one of these accounts."),
        opt("passwords", "Email and password", "Users expect it, at the cost of storing hashes and resets."),
      ],
      recommendation: localOnly
        ? rec("no-login", "A solo app on one device does not need accounts.", 0.6)
        : team
          ? rec("magic-link", "Several people need accounts; magic links avoid storing passwords.", 0.7)
          : has(p, "web") || has(p, "payments")
            ? rec("magic-link", "A web or paid app needs accounts; magic links are the simplest safe start.", 0.6)
            : rec("magic-link", "No user signal yet; magic links are the lightest real sign-in.", 0.45),
    },
    {
      id: "auth.provider",
      text: "Which auth library or service?",
      why: "Sessions, tokens and account recovery are easy to get wrong when hand written.",
      blocking: false,
      options: [
        opt("authjs", "Auth.js", "Open source, runs in your app, no per-user fee.", "free"),
        opt("clerk", "Clerk", "Hosted sign-in with orgs and roles out of the box.", "free to $25/mo"),
        opt("supabase-auth", "Supabase Auth", "Already using Supabase for the database.", "free tier"),
        opt("none", "None", "No sign-in at all."),
      ],
      recommendation: localOnly
        ? rec("none", "No accounts, so no auth library.", 0.6)
        : team
          ? rec("clerk", "Teams and roles come built in, which saves weeks.", 0.6)
          : rec("authjs", "Free and self contained for a single kind of user.", 0.5),
      research: "Auth.js vs Clerk vs Supabase Auth comparison 2026",
    },
    {
      id: "auth.roles",
      text: "What can each role see or change?",
      why: "Permissions added late leak data that was visible to everyone before.",
      blocking: team,
      options: [
        opt("single-role", "One role", "Everyone who signs in can do everything with their own data."),
        opt("owner-member", "Owner and members", "A project owner invites helpers who can edit but not delete or bill."),
        opt("custom-rbac", "Custom roles", "Several roles with fine grained permissions."),
      ],
      recommendation: team
        ? rec("owner-member", "Helpers join a project but the owner keeps billing and deletion.", 0.75)
        : rec("single-role", "A solo app has one kind of user.", 0.6),
    },
  ];
});

// ---------- Money ----------

const money = pack("money", (p) => {
  const pay = has(p, "payments");
  const subscription = /subscri/i.test(p.idea);
  return [
    {
      id: "money.payments",
      text: "Does v1 take payments, and with what?",
      why: "Payments shape accounts, tax and the database; bolting them on means reworking sign-up.",
      blocking: true,
      options: [
        opt("stripe-checkout", "Stripe Checkout", "Hosted payment page, cards and wallets, you handle tax setup.", "2.9% + 30c"),
        opt("merchant-of-record", "Paddle or Lemon Squeezy", "They act as seller and handle sales tax worldwide.", "5% + 50c"),
        opt("not-v1", "Not in v1", "Free while proving the idea."),
      ],
      recommendation: pay
        ? rec("stripe-checkout", "The idea takes money; Stripe Checkout is the fastest safe way to collect it.", 0.8)
        : rec("not-v1", "Nothing in the idea charges users, so leave payments out of v1.", 0.6),
      research: "Stripe Checkout vs Paddle vs Lemon Squeezy fees and tax handling",
    },
    {
      id: "money.pricing",
      text: "What is the pricing model?",
      why: "Subscriptions need plans, renewals and cancellation flows; one-off sales do not.",
      blocking: pay,
      options: [
        opt("free", "Free", "No charge in v1."),
        opt("one-time", "One-time purchase", "A tool people buy once."),
        opt("subscription", "Monthly subscription", "Ongoing value or ongoing costs such as AI or hosting."),
        opt("usage", "Usage based", "Cost per user varies a lot, as with heavy AI use."),
      ],
      recommendation: pay
        ? subscription || has(p, "ai")
          ? rec("subscription", "Ongoing costs per user are best covered by a monthly plan.", 0.7)
          : rec("subscription", "Most paid apps start with one simple monthly plan.", 0.55)
        : rec("free", "No payments in v1.", 0.55),
    },
    {
      id: "money.tax-refunds",
      text: "Who handles sales tax and refunds?",
      why: "Selling across borders brings tax duties from the first sale.",
      blocking: pay,
      options: [
        opt("stripe-tax", "Stripe Tax plus a refund policy", "You stay the seller and Stripe calculates tax.", "0.5% per sale"),
        opt("mor-handles", "Merchant of record handles it", "Paddle or Lemon Squeezy file the tax for you."),
        opt("not-needed", "Not needed", "No payments in v1."),
      ],
      recommendation: pay
        ? rec("stripe-tax", "Pairs with Stripe Checkout; write a short refund policy before launch.", 0.6)
        : rec("not-needed", "No payments, so no tax or refunds yet.", 0.6),
    },
  ];
});

// ---------- AI usage ----------

const ai = pack("ai", (p) => {
  const uses = has(p, "ai");
  return [
    {
      id: "ai.use",
      text: "Does v1 use AI at all?",
      why: "AI brings API keys, per-user cost and failure modes that touch every screen using it.",
      blocking: true,
      options: [
        opt("core", "Yes, it is the core feature", "The product does not work without the model."),
        opt("assist", "Yes, as an assistant", "AI helps but the app works without it."),
        opt("no", "No", "Plain software in v1."),
      ],
      recommendation: uses
        ? rec("core", "The idea is built around a model or agent.", 0.75)
        : rec("no", "Nothing in the idea needs a model; leave AI out of v1.", 0.6),
    },
    {
      id: "ai.model",
      text: "Which models, and through which API?",
      why: "Model choice sets quality, speed and cost per user.",
      blocking: uses,
      options: [
        opt("frontier-api", "Frontier model API", "Best quality for reasoning and agents.", "$3 to $15 per million tokens"),
        opt("small-api", "Small fast model API", "High volume, simple tasks.", "under $1 per million tokens"),
        opt("local-model", "Local model on device", "Offline or private data that must not leave the device.", "free, needs a good GPU"),
      ],
      recommendation: uses && has(p, "offline")
        ? rec("local-model", "It must work offline, so the model runs on the device.", 0.55)
        : uses
          ? rec("frontier-api", "Agent work needs the strongest model; use a small one for cheap steps later.", 0.6)
          : rec("small-api", "No AI planned; if added, start small and cheap.", 0.4),
      research: "LLM API comparison: quality, price per token and rate limits 2026",
    },
    {
      id: "ai.fallback",
      text: "What happens when the AI API is down or rate limited?",
      why: "Outages and rate limits happen weekly; without a plan the app just hangs.",
      blocking: uses,
      options: [
        opt("degrade", "Turn the feature off with a clear message", "The rest of the app keeps working."),
        opt("queue-retry", "Queue and retry", "Work can wait minutes without hurting the user."),
        opt("second-provider", "Fall back to a second provider", "AI is the core and downtime loses money."),
      ],
      recommendation: uses
        ? rec("degrade", "Show a clear message and keep the rest of the app usable; add retries for background jobs.", 0.65)
        : rec("degrade", "Not needed until AI is added.", 0.4),
    },
    {
      id: "ai.cost-cap",
      text: "What is the AI cost cap per user per month?",
      why: "One heavy user can cost more than they pay without a cap.",
      blocking: uses,
      options: [
        opt("hard-cap", "Hard monthly cap per user", "Stop or slow down at a set spend."),
        opt("soft-cap", "Alert only", "Trusted users, watch spend by hand."),
        opt("no-cap", "No cap", "Internal use only."),
      ],
      recommendation: uses
        ? rec("hard-cap", "A hard cap per user keeps the monthly bill predictable.", 0.7)
        : rec("hard-cap", "Not needed until AI is added.", 0.4),
    },
  ];
});

// ---------- Offline and sync ----------

const offline = pack("offline", (p) => {
  const off = has(p, "offline");
  const team = p.team === "team";
  return [
    {
      id: "offline.required",
      text: "Must it work without internet?",
      why: "Offline support decides the data store; retrofitting it means rewriting every read and write.",
      blocking: true,
      options: [
        opt("online-only", "Online only", "Users always have a connection."),
        opt("read-offline", "Read offline, write online", "Cached views, edits need a connection."),
        opt("full-offline", "Full offline with sync", "Users work in the field or on the move."),
      ],
      recommendation: off
        ? rec("full-offline", "The idea needs to work without a connection.", 0.8)
        : has(p, "mobile")
          ? rec("read-offline", "Phones lose signal; cached reads keep the app usable.", 0.55)
          : rec("online-only", "Nothing in the idea needs offline, and online-only is far simpler.", 0.55),
    },
    {
      id: "offline.conflicts",
      text: "Who wins when two edits conflict?",
      why: "Without a rule, sync silently loses someone's work.",
      blocking: off,
      options: [
        opt("last-write-wins", "Last write wins", "One person edits, or conflicts are rare and cheap."),
        opt("crdt-merge", "Merge with CRDTs", "Several people edit the same record offline."),
        opt("ask-user", "Ask the user", "Conflicts are rare but each one matters."),
        opt("server-wins", "Server wins", "The server is the authority and local edits are drafts."),
      ],
      recommendation: off && team
        ? rec("crdt-merge", "Several people editing offline need merges, not overwrites.", 0.65)
        : off
          ? rec("last-write-wins", "One person across devices rarely conflicts with themselves.", 0.6)
          : rec("last-write-wins", "Only matters once sync exists.", 0.45),
      research: "CRDT vs last-write-wins conflict resolution for local-first apps",
    },
    {
      id: "offline.sync-engine",
      text: "What syncs the local data to the server?",
      why: "Hand written sync is a project of its own.",
      blocking: false,
      options: [
        opt("powersync", "PowerSync", "SQLite on device synced to Postgres.", "free tier, then $49/mo"),
        opt("electric", "ElectricSQL", "Postgres shapes synced into the client.", "open source"),
        opt("custom", "Custom sync", "Very simple data, or unusual needs."),
        opt("none", "None", "Online only."),
      ],
      recommendation: off
        ? rec("powersync", "A ready sync engine for SQLite on device and Postgres on the server.", 0.5)
        : rec("none", "No offline need, so no sync engine.", 0.6),
      research: "PowerSync vs ElectricSQL vs custom sync 2026",
    },
  ];
});

// ---------- Security and privacy ----------

const security = pack("security", (p) => {
  const personal = has(p, "personal-data");
  return [
    {
      id: "security.personal-data",
      text: "What personal data is stored, and can we store less?",
      why: "Data you never store can never leak; privacy law applies from the first user.",
      blocking: true,
      options: [
        opt("store-none", "None", "No personal data at all."),
        opt("store-minimum", "The minimum", "Only what a feature needs, deleted when it is not."),
        opt("store-needed", "Whatever features need", "Fast to build, larger risk."),
      ],
      recommendation: personal
        ? rec("store-minimum", "The idea holds personal data; keep only what each feature needs.", 0.75)
        : rec("store-minimum", "Storing the minimum costs little and avoids later clean up.", 0.5),
    },
    {
      id: "security.encryption",
      text: "How is data encrypted at rest?",
      why: "A lost laptop or leaked backup should not expose personal data.",
      blocking: personal,
      options: [
        opt("provider-default", "Provider disk encryption", "Ordinary data on a managed host."),
        opt("field-level", "Field level encryption for sensitive data", "Health, addresses or other personal records."),
        opt("none", "None", "Public or throwaway data only."),
      ],
      recommendation: personal
        ? rec("field-level", "Personal fields are encrypted on top of disk encryption.", 0.7)
        : rec("provider-default", "Disk encryption from the host is enough for ordinary data.", 0.55),
    },
    {
      id: "security.access",
      text: "Who must never see the data?",
      why: "Access rules are easier to keep than to add after people rely on seeing everything.",
      blocking: false,
      options: [
        opt("owner-only", "Only the owner", "Private data, even admins cannot read it."),
        opt("project-members", "Project members", "Helpers see the project they joined, nothing else."),
        opt("support-audited", "Support with an audit log", "Staff may need to look, and every look is logged."),
      ],
      recommendation: p.team === "team"
        ? rec("project-members", "Helpers see only the projects they were added to.", 0.65)
        : personal
          ? rec("owner-only", "Personal data stays with its owner.", 0.6)
          : rec("owner-only", "No sharing signal; private by default.", 0.45),
    },
    {
      id: "security.secrets",
      text: "Where do API keys and secrets live?",
      why: "A key committed to git or left in a plain file is the most common leak.",
      blocking: false,
      options: [
        opt("os-keychain", "OS keychain", "Desktop apps holding a user's own keys."),
        opt("secret-manager", "Host secret manager", "Server side keys in production."),
        opt("env-file", "Local .env file", "Development only, never committed."),
      ],
      recommendation: has(p, "desktop")
        ? rec("os-keychain", "A desktop app keeps keys in the Windows, macOS or Linux keychain.", 0.7)
        : rec("secret-manager", "Server keys belong in the host's secret store.", 0.55),
    },
  ];
});

// ---------- Scale and cost ----------

const scale = pack("scale", (p) => {
  const usesAi = has(p, "ai");
  return [
    {
      id: "scale.users",
      text: "How many users in year one?",
      why: "The answer sets the database tier, hosting plan and whether caching matters.",
      blocking: true,
      options: [
        opt("under-100", "Under 100", "Personal tool or a small group."),
        opt("under-10k", "Up to 10,000", "A public app finding its users."),
        opt("over-10k", "More than 10,000", "Launching to an existing audience."),
      ],
      recommendation: has(p, "web") || has(p, "payments")
        ? rec("under-10k", "A public or paid app should plan for thousands, not millions.", 0.55)
        : p.team === "solo" && has(p, "desktop")
          ? rec("under-100", "A solo desktop tool starts with a handful of users.", 0.55)
          : rec("under-100", "No audience signal; plan small and measure.", 0.45),
    },
    {
      id: "scale.budget",
      text: "What can it cost per month in year one?",
      why: "Hosting, database and AI bills add up quietly.",
      blocking: usesAi,
      options: [
        opt("free-tier", "Free tiers only", "Hobby or proof of concept.", "$0"),
        opt("under-50", "Under $50 a month", "Small paid hosting and database.", "$0 to $50/mo"),
        opt("under-500", "Under $500 a month", "AI usage or many active users.", "$50 to $500/mo"),
      ],
      recommendation: usesAi
        ? rec("under-500", "AI calls are the main cost; budget for them up front.", 0.6)
        : has(p, "desktop") && !has(p, "web") && p.team === "solo"
          ? rec("free-tier", "A local app has almost no running costs.", 0.55)
          : rec("under-50", "Small hosting and a database fit under $50.", 0.5),
    },
    {
      id: "scale.cost-watch",
      text: "How is spend watched?",
      why: "Bills that surprise you arrive a month late.",
      blocking: false,
      options: [
        opt("billing-alerts", "Billing alerts", "Email when spend passes a set amount."),
        opt("per-feature-metering", "Metering per feature and user", "Costs vary by user, as with AI."),
        opt("none", "Nothing", "Free tiers only."),
      ],
      recommendation: usesAi
        ? rec("per-feature-metering", "AI cost per user must be measured to enforce a cap.", 0.65)
        : rec("billing-alerts", "A spend alert on each provider is enough.", 0.6),
    },
  ];
});

// ---------- Testing and release ----------

const testing = pack("testing", (p) => {
  const desktop = has(p, "desktop");
  const mobile = has(p, "mobile");
  const web = has(p, "web");
  return [
    {
      id: "testing.strategy",
      text: "How is it tested before release?",
      why: "Tests written after the code tend to test what it does, not what it should do.",
      blocking: true,
      options: [
        opt("unit-integration", "Unit and integration tests in CI", "Logic and data layers covered on every push."),
        opt("e2e-heavy", "End to end tests first", "Flows such as checkout that must never break."),
        opt("manual", "Manual checks", "Throwaway prototypes only."),
      ],
      recommendation: has(p, "payments")
        ? rec("unit-integration", "Unit and integration tests on every push, plus one end to end test of checkout.", 0.65)
        : rec("unit-integration", "Fast tests on every push catch most breakage cheaply.", 0.6),
    },
    {
      id: "testing.deploy",
      text: "Where does it deploy, and how?",
      why: "Release steps done by hand get skipped under pressure.",
      blocking: false,
      options: [
        opt("ci-preview-prod", "CI with preview and production deploys", "Web apps on a managed host."),
        opt("github-releases", "Signed builds on GitHub Releases", "Desktop apps with auto update."),
        opt("app-stores", "App Store and Play Store", "Mobile apps, with review delays."),
        opt("manual", "Manual deploy", "One-off scripts and demos."),
      ],
      recommendation: web
        ? rec("ci-preview-prod", "Every branch gets a preview and main deploys to production.", 0.7)
        : desktop
          ? rec("github-releases", "Signed Windows, macOS and Linux builds from CI with auto update.", 0.7)
          : mobile
            ? rec("app-stores", "Mobile apps ship through the stores; plan for review time.", 0.7)
            : rec("ci-preview-prod", "No platform signal; CI deploys are the safe default.", 0.45),
      research: "CI release pipelines for web, desktop (Tauri) and mobile (Expo) apps",
    },
    {
      id: "testing.rollback",
      text: "How do you roll back a bad release?",
      why: "A rollback plan made during an outage is a bad plan.",
      blocking: false,
      options: [
        opt("redeploy-previous", "Redeploy the previous build", "Hosts that keep old deploys, or pinned releases."),
        opt("feature-flags", "Feature flags", "Turn a feature off without a new build."),
        opt("forward-fix", "Fix forward only", "Tiny apps with fast deploys."),
      ],
      recommendation: mobile || desktop
        ? rec("feature-flags", "Installed apps cannot be pulled back quickly; flags switch features off remotely.", 0.6)
        : rec("redeploy-previous", "Managed hosts can promote the previous deploy in one click.", 0.6),
    },
  ];
});

// ---------- Platforms ----------

const platforms = pack("platforms", (p) => {
  const web = has(p, "web");
  const desktop = has(p, "desktop");
  const mobile = has(p, "mobile");
  const count = [web, desktop, mobile].filter(Boolean).length;
  return [
    {
      id: "platforms.first",
      text: "Web, desktop or mobile: which comes first?",
      why: "The first platform sets the UI toolkit and the release process.",
      blocking: true,
      options: [
        opt("web", "Web", "Reach anyone with a browser, fastest to ship."),
        opt("desktop", "Desktop", "Local files, keychain and offline work."),
        opt("mobile", "Mobile", "Used on the move, camera and notifications."),
      ],
      recommendation: count === 1
        ? rec(web ? "web" : desktop ? "desktop" : "mobile", "The idea names one platform.", 0.8)
        : count > 1
          ? rec(web ? "web" : "desktop", "Several platforms named; start where the shared core is easiest to prove.", 0.6)
          : rec("web", "No platform named; web reaches the most people fastest.", 0.45),
    },
    {
      id: "platforms.desktop-shell",
      text: "Which desktop shell?",
      why: "The shell decides install size, auto update and native access.",
      blocking: desktop,
      options: [
        opt("tauri", "Tauri", "Small installers on Windows, macOS and Linux using the system webview."),
        opt("electron", "Electron", "Needs identical Chromium everywhere or Node in the app."),
        opt("none", "No desktop app", "Web or mobile only."),
      ],
      recommendation: desktop
        ? rec("tauri", "Small, fast installers for Windows, macOS and Linux from one codebase.", 0.75)
        : rec("none", "No desktop need in the idea.", 0.6),
      research: "Tauri vs Electron 2026 bundle size, auto update and native APIs",
    },
    {
      id: "platforms.mobile-stack",
      text: "Which mobile stack?",
      why: "Native, cross platform and web apps need very different skills.",
      blocking: mobile,
      options: [
        opt("expo", "React Native with Expo", "iOS and Android from one TypeScript codebase."),
        opt("native", "Swift and Kotlin", "Heavy native features or best possible performance."),
        opt("pwa", "Installable web app", "Light mobile use without app store review."),
        opt("none", "No mobile app", "Web or desktop only."),
      ],
      recommendation: mobile
        ? rec("expo", "One TypeScript codebase for iOS and Android with over the air updates.", 0.75)
        : rec("none", "No mobile need in the idea.", 0.6),
      research: "Expo React Native vs native Swift Kotlin vs PWA 2026",
    },
    {
      id: "platforms.shared",
      text: "What must be shared across platforms?",
      why: "Logic copied per platform drifts apart within weeks.",
      blocking: false,
      options: [
        opt("shared-core", "A shared TypeScript core", "Data, rules and API client used by every platform."),
        opt("shared-api", "Only the server API", "Each platform has its own client code."),
        opt("nothing", "Nothing", "One platform only."),
      ],
      recommendation: count > 1
        ? rec("shared-core", "Several platforms should share one core of logic and types.", 0.7)
        : count === 1
          ? rec("nothing", "One platform for now; keep the core separate so sharing is easy later.", 0.5)
          : rec("shared-core", "No platform named; a shared core keeps options open.", 0.45),
    },
  ];
});

/** One pack per area, in AREAS order. */
export const PACKS: readonly QuestionPack[] = [stack, data, auth, money, ai, offline, security, scale, testing, platforms];

/** The pack for one area. */
export function packFor(area: Area): QuestionPack {
  const found = PACKS.find((p) => p.area === area);
  if (!found) throw new Error(`no question pack for area "${area}"`);
  return found;
}

/** All open questions for the profile, in area order, skipping ones the scan already answered. */
export function questionsFor(profile: IdeaProfile): PlanningQuestion[] {
  return AREAS.flatMap((area) => packFor(area).questions(profile)).filter((q) => !(q.id in profile.known));
}

/** One question by id, built for this profile (known answers included). */
export function findQuestion(profile: IdeaProfile, id: string): PlanningQuestion | undefined {
  const area = id.split(".")[0] as Area;
  if (!(AREAS as readonly string[]).includes(area)) return undefined;
  return packFor(area).questions(profile).find((q) => q.id === id);
}
