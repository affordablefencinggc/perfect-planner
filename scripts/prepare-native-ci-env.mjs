// Prepares fresh, empty, long-form fixture roots for `npm run test:native` on a CI runner and
// exports them through $GITHUB_ENV. The runner's default %TEMP% is an 8.3 short path
// (C:\Users\RUNNER~1\...), which the native path-canonicality checks correctly refuse, so the
// tests are given a canonical temp root instead. Outside GitHub Actions this only prints the
// values it would export.
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = path.join(realpathSync.native(process.env.RUNNER_TEMP || os.tmpdir()), `pp-native-${process.pid}`);
const fresh = (name) => { const dir = path.join(base, name); mkdirSync(dir, { recursive: true }); return realpathSync.native(dir); };
const tmp = fresh("tmp");
const values = {
  TMP: tmp,
  TEMP: tmp,
  PP_CUSTODY_PROBE_ROOT: fresh("custody-probe"),
  PP_ARCHIVE_FIXTURE_ROOT: fresh("archive-fixture"),
  PP_TEST_AGENT_NODE: process.execPath,
};
const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, lines);
process.stdout.write(lines);
