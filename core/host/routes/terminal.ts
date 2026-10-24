// The in-app script pane: one-click sign-in and connect scripts whose output shows in the app. The
// person picks a script from a fixed list, reads the exact command, and starts it; nothing runs on its
// own. Programs start without a shell, found by core/exec. Anything the person types (a key, a
// password) goes straight to the program's input: it is never stored, logged, or sent back, and the
// output is scrubbed of it. The scripts are chosen by id; the app never runs text the window sends.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, NO_CWD_SEARCH_ENV } from "../../exec/index";
import { agentLaunch } from "../agentLaunch";
import { AGENTS, type AgentKind } from "../agentKinds";
import { childEnv } from "../protectedRoots";
import { HttpError, type Router } from "../router";
import { agentEntryPath, connectProgram, issueConnection, projectRoots } from "./agents";

export type RunState = "idle" | "running" | "done" | "failed" | "stopped";

interface Script {
  id: string;
  group: "Agents" | "Cloud" | "Code";
  label: string;
  /** What this does, in plain words, shown before it runs. */
  about: string;
  /** The command as shown to the person. */
  shown: string;
  /** True when the program will ask for something the person types (a key, a code). */
  asks: boolean;
}

interface Run {
  script: string;
  state: RunState;
  output: string;
  /** Bytes dropped from the front, so the window can tell how far it has read. */
  dropped: number;
  exitCode?: number;
  child?: ChildProcess;
  secrets: string[];
}

const MAX_OUTPUT = 64_000;
const MAX_MS = 10 * 60_000;
const MAX_INPUT = 4096;
const runs = new Map<string, Run>();

const CLOUD: Record<string, { cli: string; args: string[]; label: string; about: string; asks: boolean; group: Script["group"] }> = {
  "gcloud-login": { cli: "gcloud", args: ["auth", "login"], label: "Google Cloud: sign in", about: "Opens Google's sign-in page in your browser. Nothing is typed here.", asks: false, group: "Cloud" },
  "gcloud-init": { cli: "gcloud", args: ["init"], label: "Google Cloud: set up", about: "Walks through choosing your account and project. It asks questions you answer below.", asks: true, group: "Cloud" },
  "aws-configure": { cli: "aws", args: ["configure"], label: "Amazon: enter your keys", about: "Asks for your access key, secret key, region and output. Type them in the box below; they go to the AWS tool only.", asks: true, group: "Cloud" },
  "aws-sso": { cli: "aws", args: ["sso", "login"], label: "Amazon: single sign-on", about: "Opens your company's AWS sign-in page in your browser.", asks: false, group: "Cloud" },
  "azure-login": { cli: "az", args: ["login"], label: "Azure: sign in", about: "Opens Microsoft's sign-in page in your browser.", asks: false, group: "Cloud" },
  "github-login": { cli: "gh", args: ["auth", "login", "--web"], label: "GitHub: sign in", about: "Shows a one-time code and opens GitHub in your browser.", asks: true, group: "Code" },
  "codex-login": { cli: "codex", args: ["login"], label: "Codex: sign in", about: "Opens the ChatGPT sign-in page in your browser.", asks: false, group: "Agents" },
};

const CONNECT_IDS = Object.fromEntries((Object.keys(AGENTS) as AgentKind[]).map((agent) => [`connect-${agent}`, agent])) as Record<string, AgentKind>;

function catalog(): Script[] {
  const connect: Script[] = (Object.keys(AGENTS) as AgentKind[]).map((agent) => ({
    id: `connect-${agent}`,
    group: "Agents",
    label: `Connect ${AGENTS[agent].label}`,
    about: `Sets up ${AGENTS[agent].label} for this project folder so it can check in. No credentials: the connection key stays in a file only you can read.`,
    shown: `node connect.mjs --agent ${agent} <this app's address> <connection key file>`,
    asks: false,
  }));
  const rest: Script[] = Object.entries(CLOUD).map(([id, c]) => ({ id, group: c.group, label: c.label, about: c.about, shown: [c.cli, ...c.args].join(" "), asks: c.asks }));
  return [...connect, ...rest];
}

/** A program that is only a .cmd shim, or in a protected folder, is not run: say which, plainly. */
function findProgram(cli: string, env: NodeJS.ProcessEnv, cwd: string, roots: string[]): { command: string; args: string[] } | null {
  if (cli === "codex") return agentLaunch("codex", [], env, cwd, roots);
  const program = findExecutable(cli, env, cwd, process.platform, roots, { windowsExtensions: [".exe"] });
  return program ? { command: program, args: [] } : null;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 3) out = out.split(secret).join("••••");
  return out;
}

function view(run: Run | undefined, from: number) {
  if (!run) return { state: "idle" as const, output: "", next: 0 };
  const end = run.dropped + run.output.length;
  const start = Math.max(from, run.dropped);
  return {
    state: run.state,
    script: run.script,
    output: run.output.slice(start - run.dropped),
    next: end,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
  };
}

export function registerTerminalRoutes(router: Router): void {
  /** GET /terminal/scripts: the fixed list, with the exact command each one runs. */
  router.get("/terminal/scripts", () => ({ scripts: catalog(), platform: process.platform === "win32" ? "windows" : "linux" }));

  /** GET /terminal/run?from=N: the run's state and the output after offset N. */
  router.get("/terminal/run", ({ project, query }) => view(runs.get(project.key), Math.max(0, Number(query.get("from")) || 0)));

  /** POST /terminal/run { script }: start one script from the list. Only one runs at a time. */
  router.post("/terminal/run", async ({ project, host, body }) => {
    const id = String((body as { script?: unknown } | null)?.script ?? "");
    const script = catalog().find((s) => s.id === id);
    if (!script) throw new HttpError(400, "INVALID", "That script is not on the list.");
    if (runs.get(project.key)?.state === "running") throw new HttpError(409, "BUSY", "A script is already running. Stop it or wait for it to finish.");
    const roots = projectRoots(project);
    const cwd = path.join(os.tmpdir(), "pp-terminal");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...childEnv(process.env, { cwd, protect: roots }), ...NO_CWD_SEARCH_ENV };
    let command: string;
    let args: string[];
    const agent = CONNECT_IDS[id];
    if (agent) {
      const entry = agentEntryPath();
      if (!entry.built) throw new HttpError(409, "NOT_BUILT", "The agent program is not built yet, so it cannot be connected from here.");
      const made = await issueConnection(project, host, {});
      command = process.execPath;
      args = [connectProgram(entry.path), "--agent", agent, made.bridgeUrl, made.tokenFile];
    } else {
      const spec = CLOUD[id];
      const found = findProgram(spec.cli, process.env, cwd, roots);
      if (!found) throw new HttpError(404, "MISSING", `${spec.cli} is not installed here, or this app cannot run it directly (a .cmd launcher). Install it, or sign in from your own terminal.`);
      command = found.command;
      args = [...found.args, ...spec.args];
    }
    const run: Run = { script: id, state: "running", output: "", dropped: 0, secrets: [] };
    runs.set(project.key, run);
    const append = (text: string) => {
      run.output = scrub(run.output + text, run.secrets);
      if (run.output.length > MAX_OUTPUT) {
        const cut = run.output.length - MAX_OUTPUT;
        run.dropped += cut;
        run.output = run.output.slice(cut);
      }
    };
    append(`$ ${script.shown}\n`);
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    run.child = child;
    const timer = setTimeout(() => {
      append("\n[Stopped: it ran for 10 minutes.]\n");
      child.kill("SIGKILL");
    }, MAX_MS);
    child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    child.stdin?.on("error", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      run.state = "failed";
      append("\n[It could not be started.]\n");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      delete run.child;
      run.secrets = [];
      if (run.state === "running") run.state = code === 0 ? "done" : "failed";
      run.exitCode = code ?? -1;
    });
    return view(run, 0);
  });

  /** POST /terminal/input { text, secret }: a line for the running program. A secret is never shown or kept. */
  router.post("/terminal/input", ({ project, body }) => {
    const { text, secret } = (body ?? {}) as { text?: unknown; secret?: unknown };
    const run = runs.get(project.key);
    if (!run?.child || run.state !== "running") throw new HttpError(409, "NOT_RUNNING", "Nothing is waiting for input.");
    if (typeof text !== "string" || text.length > MAX_INPUT || /[\r\n\0]/.test(text)) throw new HttpError(400, "INVALID", "Type one line, up to 4096 characters.");
    if (secret === true) run.secrets.push(text);
    else run.output += `${text}\n`;
    run.child.stdin?.write(`${text}\n`);
    return view(run, run.dropped + run.output.length);
  });

  /** POST /terminal/stop: end the running script. */
  router.post("/terminal/stop", ({ project }) => {
    const run = runs.get(project.key);
    if (run?.child && run.state === "running") {
      run.state = "stopped";
      run.child.kill("SIGKILL");
    }
    return view(run, run ? run.dropped + run.output.length : 0);
  });
}
