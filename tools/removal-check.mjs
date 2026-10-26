#!/usr/bin/env node
// The Test stage's own check, run after the programs exist (agenticdevelopment.ai, stage
// Test: "the suite fails against empty stand-ins for every program the statement names, and,
// once the programs exist, notices each one removed").
//
// In a temporary copy of the repository:
//   1. Every program in scripts/ is replaced by its empty stand-in. No test may pass.
//   2. Each program in turn is replaced by its stand-in, or deleted when it has none. At
//      least one test must fail each time. A program whose absence nothing notices is
//      named, because nothing tests it.
//
// Usage: node tools/removal-check.mjs     (exit 0 only when both hold)
// Node 22 or later, nothing else.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = "agents/security-reviewer";
const SCRIPTS = join(AGENT, "scripts");
const STAND_INS = join(AGENT, "test", "stand-ins");

function copyRepo() {
  const dir = join(mkdtempSync(join(tmpdir(), "sr-removal-")), "repo");
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(src.slice(ROOT.length)) });
  return dir;
}

function suite(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `${AGENT}/test/*.test.mjs`], { cwd: dir, encoding: "utf8", timeout: 600000 });
  const count = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)$`, "m")) ?? [])[1] ?? NaN);
  return { pass: count("pass"), fail: count("fail"), tests: count("tests") };
}

const programs = readdirSync(join(ROOT, SCRIPTS)).filter((f) => /\.(mjs|js|cjs)$/.test(f)).sort();
const standIns = new Set(readdirSync(join(ROOT, STAND_INS)).filter((f) => f.endsWith(".mjs")));
let ok = true;

// 1. Every program replaced at once.
{
  const dir = copyRepo();
  for (const f of programs) {
    if (standIns.has(f)) cpSync(join(dir, STAND_INS, f), join(dir, SCRIPTS, f));
    else rmSync(join(dir, SCRIPTS, f));
  }
  for (const f of standIns) if (!existsSync(join(dir, SCRIPTS, f))) cpSync(join(dir, STAND_INS, f), join(dir, SCRIPTS, f));
  const r = suite(dir);
  const holds = r.pass === 0 && r.tests > 0;
  if (!holds) ok = false;
  process.stdout.write(`${holds ? "pass" : "FAIL"}  against empty stand-ins: ${r.pass} of ${r.tests} tests pass (must be 0)\n`);
  rmSync(dirname(dir), { recursive: true, force: true });
}

// 2. Each program removed in turn.
for (const f of programs) {
  const dir = copyRepo();
  if (standIns.has(f)) cpSync(join(dir, STAND_INS, f), join(dir, SCRIPTS, f));
  else rmSync(join(dir, SCRIPTS, f));
  const r = suite(dir);
  const noticed = r.fail > 0;
  if (!noticed) ok = false;
  process.stdout.write(`${noticed ? "pass" : "FAIL"}  without ${f}: ${r.fail} of ${r.tests} tests fail${noticed ? "" : " (nothing tests this program)"}\n`);
  rmSync(dirname(dir), { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
