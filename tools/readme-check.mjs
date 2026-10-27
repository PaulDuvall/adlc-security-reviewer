#!/usr/bin/env node
// The README's figures, checked against the repository: the spec's version, the number of
// tests, the number of Code-stage rounds, the programs' lines and the locked files. A push that
// changes any of them refreshes README.md in the same push (CLAUDE.md); this check, run by
// `npm run verify` and in CI, fails when it did not. It checks figures, not prose.
//
//   node tools/readme-check.mjs
//
// Node 22 or later, nothing else.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SCRIPTS = "agents/security-reviewer/scripts";
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const version = /^Version (\d+\.\d+\.\d+)\./m.exec(read("docs/spec.md"))?.[1];
const tests = new Set();
for (const line of read("docs/traceability.md").split("\n")) {
  const cells = line.split("|").map((c) => c.trim());
  if (/^SR-\d+$/.test(cells[1] ?? "")) for (const name of cells[2].split("<br>")) if (name.trim()) tests.add(name.trim());
}
const rounds = read("docs/rounds.md").split("\n").filter((l) => /^\| \d+ \|/.test(l)).length;
const lines = readdirSync(join(ROOT, SCRIPTS)).filter((f) => f.endsWith(".mjs"))
  .reduce((n, f) => n + read(`${SCRIPTS}/${f}`).split("\n").length - 1, 0);
const locked = Object.keys(JSON.parse(read("LOCK.json")).files).length;

const readme = read("README.md");
const facts = [
  [`spec ${version}`, "the spec's version, from docs/spec.md"],
  [`${tests.size} of ${tests.size}`, "the number of tests, from docs/traceability.md"],
  [`${rounds} rounds`, "the number of Code-stage rounds, from docs/rounds.md"],
  [`${grouped(lines)} lines`, `the programs' lines, from ${SCRIPTS}`],
  [`${locked} files locked`, "the locked files, from LOCK.json"],
];
const stale = facts.filter(([text]) => !readme.includes(text));
if (stale.length) {
  process.stderr.write(`README.md is not current. Refresh it in this push; it must say:\n${stale.map(([text, from]) => `  "${text}": ${from}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`README current: spec ${version}, ${tests.size} tests, ${rounds} rounds, ${grouped(lines)} lines, ${locked} files locked\n`);
