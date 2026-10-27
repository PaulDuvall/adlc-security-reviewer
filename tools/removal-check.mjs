#!/usr/bin/env node
// The Test stage's own check, run after the programs exist (agenticdevelopment.ai, stage
// Test: "the suite fails against empty stand-ins for every program the statement names, and,
// once the programs exist, notices each one removed").
//
//   0. Once the programs exist, the suite run as it is passes every test that
//      docs/traceability.md names, by name, and no other. A count alone would let a program
//      that ends its test file early, or a skipped test, pass for the whole file.
// Then, in a temporary copy of the repository:
//   1. Every program in scripts/ is replaced by its empty stand-in. Every traced test runs,
//      and none passes.
//   2. Each program in turn is replaced by its stand-in, or deleted when it has none. At
//      least one test must fail each time. A program whose absence nothing notices is
//      named, because nothing tests it.
//
// Usage: node tools/removal-check.mjs     (exit 0 only when all hold)
// Node 22.13 or later, nothing else.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** Every test name the traceability matrix lists, from each requirement row's Tests cell. */
function tracedNames() {
  const names = new Set();
  for (const line of readFileSync(join(ROOT, "docs", "traceability.md"), "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (/^SR-\d+$/.test(cells[1] ?? "")) for (const name of cells[2].split("<br>")) if (name.trim()) names.add(name.trim());
  }
  return names;
}

// A top-level TAP result: its name, then any directive after an unescaped " # ". A program's
// own output reaches the runner's TAP only as an indented or "# " comment line.
const RESULT = /^(not )?ok \d+ - ((?:[^\\#]|\\.)*?)(?: # (\w+).*)?$/gm;
const unescaped = (name) => name.replace(/\\(.)/g, "$1").trim();

function suite(dir) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `${AGENT}/test/*.test.mjs`], { cwd: dir, encoding: "utf8", timeout: 600000 });
  // The runner's own summary is the last such line; a program's output can print earlier ones.
  const count = (k) => Number([...r.stdout.matchAll(new RegExp(`^# ${k} (\\d+)$`, "gm"))].at(-1)?.[1] ?? NaN);
  const passed = new Set();
  for (const m of r.stdout.matchAll(RESULT)) if (!m[1] && !m[3]) passed.add(unescaped(m[2]));
  return { pass: count("pass"), fail: count("fail"), tests: count("tests"), passed };
}

const programs = readdirSync(join(ROOT, SCRIPTS)).filter((f) => /\.(mjs|js|cjs)$/.test(f)).sort();
const standIns = new Set(readdirSync(join(ROOT, STAND_INS)).filter((f) => f.endsWith(".mjs")));
const traced = tracedNames();
let ok = true;

// 0. The programs as they are.
const written = programs.some((f) => !standIns.has(f)
  || !readFileSync(join(ROOT, SCRIPTS, f)).equals(readFileSync(join(ROOT, STAND_INS, f))));
if (written) {
  const r = suite(ROOT);
  const missing = [...traced].filter((n) => !r.passed.has(n));
  const untraced = [...r.passed].filter((n) => !traced.has(n));
  const holds = r.fail === 0 && !missing.length && !untraced.length;
  if (!holds) ok = false;
  process.stdout.write(`${holds ? "pass" : "FAIL"}  with the programs: ${traced.size - missing.length} of ${traced.size} traced tests pass, by name\n`);
  for (const n of missing) process.stdout.write(`        not passed: ${n}\n`);
  for (const n of untraced) process.stdout.write(`        not in docs/traceability.md: ${n}\n`);
} else {
  process.stdout.write("note  the programs are still the empty stand-ins, so the suite is not yet expected to pass\n");
}

// 1. Every program replaced at once.
{
  const dir = copyRepo();
  for (const f of programs) {
    if (standIns.has(f)) cpSync(join(dir, STAND_INS, f), join(dir, SCRIPTS, f));
    else rmSync(join(dir, SCRIPTS, f));
  }
  for (const f of standIns) if (!existsSync(join(dir, SCRIPTS, f))) cpSync(join(dir, STAND_INS, f), join(dir, SCRIPTS, f));
  const r = suite(dir);
  const holds = r.pass === 0 && r.tests === traced.size;
  if (!holds) ok = false;
  process.stdout.write(`${holds ? "pass" : "FAIL"}  against empty stand-ins: ${r.pass} of ${r.tests} tests pass (must be 0, with all ${traced.size} traced tests run)\n`);
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
