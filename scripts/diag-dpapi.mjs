// Temporary diagnostic: how long does the fixed DPAPI PowerShell take under different environments?
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $request=[Console]::In.ReadToEnd()|ConvertFrom-Json; $bytes=[Convert]::FromBase64String([string]$request.value); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); @{value=[Convert]::ToBase64String($result)}|ConvertTo-Json -Compress`;
const scratch = mkdtempSync(path.join(os.tmpdir(), "dpapi-"));
const base = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: scratch, TMP: scratch };
const pick = (...names) => Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
const cases = {
  stripped: base,
  profile: { ...base, ...pick("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN") },
  profileData: { ...base, ...pick("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "ProgramData", "ALLUSERSPROFILE", "PUBLIC") },
  psmodule: { ...base, ...pick("PSModulePath") },
  programData: { ...base, ...pick("ProgramData", "ALLUSERSPROFILE") },
  comspecPath: { ...base, ...pick("ComSpec", "PATH", "PATHEXT") },
  full: { ...process.env },
};
for (const [name, env] of Object.entries(cases)) {
  for (let round = 1; round <= 2; round++) {
    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { cwd: "C:\\Windows\\System32", env, windowsHide: true });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); resolve({ code: "timeout", out, err }); }, 60000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
      child.stdin.end(JSON.stringify({ value: Buffer.from("hello").toString("base64") }));
    });
    console.log(`${name} round ${round}: ${Date.now() - started} ms, exit ${result.code}, out ${result.out.slice(0, 40)} err ${result.err.replace(/\s+/g, " ").slice(0, 400)}`);
  }
}
console.log("env keys:", Object.keys(process.env).sort().join(","));
