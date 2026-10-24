// A real core host in its own process, for the attack suite to kill. It is bundled with esbuild by
// crash.test.ts, started with a data folder, a project folder and a key file, and prints one JSON line
// ({ base, launch, pid }) when it listens. The test claims the launch secret like the app window does and drives it
// over HTTP, then kills the whole process group (SIGKILL: no handler, no cleanup, git children included).
//
// Crash points that a timer cannot hit reliably are switched on by environment variables. Each one kills the
// process group at the named moment, which is what an outside SIGKILL at that instant does:
//   PP_CRASH_BEFORE_TYPE=test.passed   just before the ledger appends an entry of that type
//   PP_CRASH_TORN_AT=3                 while the 3rd ledger append writes its line: half the line is on disk
//   PP_CRASH_BEFORE_HEAD_AT=3          after the 3rd line is on disk and synced, before HEAD is updated
//   PP_CRASH_AFTER_HEAD_AT=3           after the 3rd entry is completely on disk, before the caller learns of it
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, Ledger } from "../ledger/index";
import { createCoreHost } from "../host/index";
import { hostKeysOn } from "./helpers";

const env = process.env;
const die = (): never => {
  // A negative pid is the whole group: this process and every git or test it started. Windows has no process groups
  // (process.kill(-pid) throws there, and the host would then survive its own crash point), so it dies alone; the
  // test then ends anything left with taskkill /T /F (helpers.hostKillPlan). Found by the first Windows run of attack 5a.
  if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
  process.kill(process.pid, "SIGKILL");
  return undefined as never;
};

const beforeType = env.PP_CRASH_BEFORE_TYPE;
if (beforeType) {
  const original = Ledger.prototype.append;
  Ledger.prototype.append = function (this: Ledger, draft) {
    if (draft.type === beforeType) die();
    return original.call(this, draft);
  };
}

let appended = 0;
const tornAt = Number(env.PP_CRASH_TORN_AT ?? 0);
const beforeHeadAt = Number(env.PP_CRASH_BEFORE_HEAD_AT ?? 0);
const afterHeadAt = Number(env.PP_CRASH_AFTER_HEAD_AT ?? 0);
if (tornAt || beforeHeadAt || afterHeadAt) {
  const original = FileStore.prototype.append;
  FileStore.prototype.append = function (this: FileStore, entry, previous) {
    appended += 1;
    const line = `${JSON.stringify(entry)}\n`;
    const file = path.join(this.dir, `${entry.at.slice(0, 7)}.jsonl`);
    if (appended === tornAt) {
      const fd = fs.openSync(file, "a");
      fs.writeSync(fd, line.slice(0, Math.floor(line.length / 2)));
      fs.fsyncSync(fd);
      die();
    }
    if (appended === beforeHeadAt) {
      const fd = fs.openSync(file, "a");
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      die();
    }
    original.call(this, entry, previous);
    if (appended === afterHeadAt) die();
  };
}

const host = createCoreHost({ root: env.PP_ATTACK_DATA!, projectRootOverride: env.PP_ATTACK_PROJECT!, bridge: true, keys: hostKeysOn(env.PP_ATTACK_SECRETS!) });
const server = http.createServer((req, res) => host.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  process.stdout.write(`${JSON.stringify({ base: `http://127.0.0.1:${port}/api/core`, launch: host.issueLaunch(), pid: process.pid })}\n`);
});
