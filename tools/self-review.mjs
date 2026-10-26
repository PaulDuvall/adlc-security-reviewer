#!/usr/bin/env node
// The reviewer reviews its own package (SR-21). Exit 0 only when it passes.
// Node 22 or later, nothing else.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, [
  "--permission", "--allow-fs-read=*", join(ROOT, "agents/security-reviewer/scripts/review.mjs"),
], { cwd: ROOT, input: readFileSync(join(ROOT, "conformance/self-review.json")), encoding: "utf8" });

let answer = null;
try { answer = JSON.parse(r.stdout); } catch { /* reported below */ }
if (answer?.result === "passed") {
  process.stdout.write(`self-review passed: ${answer.statement.package.digest}\n`);
  process.exit(0);
}
process.stderr.write(`self-review did not pass:\n${r.stdout || r.stderr}\n`);
process.exit(1);
