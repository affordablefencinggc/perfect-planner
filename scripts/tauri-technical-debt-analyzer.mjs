import path from "node:path";
import { runTauriTechnicalDebtAnalyzer } from "../src/node/tauriTechnicalDebtAnalyzer.mjs";

const workspaceRoot = process.cwd();
const cargoPath = process.env.PP_CARGO_PATH || path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");

try {
  const result = await runTauriTechnicalDebtAnalyzer({ workspaceRoot, files: process.argv.slice(2), cargoPath });
  const receipt = { schemaVersion: 1, analyzer: "perfect-planner-tauri-security-clippy-v1", passed: result.passed, coveredFiles: result.inspection.coveredFiles, blockers: result.inspection.blockers, cargoExitCode: result.cargo?.exitCode ?? null, cargoShell: result.cargo?.shell ?? false };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
