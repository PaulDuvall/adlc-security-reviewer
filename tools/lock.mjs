#!/usr/bin/env node
// The handoff lock. Everything the Test stage handed over is read-only to the Code stage:
// the statement, the suite, the stand-ins, the harness, the tools and the guardrails. This
// file records the digest of each, and --verify fails when any of them changed, appeared or
// disappeared. Only the paths in WRITABLE may change.
//
//   node tools/lock.mjs --write    record the lock (the spec owner, at handoff)
//   node tools/lock.mjs --verify   check it (every round, and in CI)
//
// Node 22 or later, nothing else.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = "LOCK.json";

/** What the Code stage may write. Everything else is locked. */
export const WRITABLE = [
  /^agents\/security-reviewer\/scripts\/[a-z0-9-]+\.mjs$/,
  /^docs\/rounds\.md$/,
  /^README\.md$/,
];
const IGNORED = [/^\.git\//, /(^|\/)node_modules\//, /^\.claude\/settings\.local\.json$/, /(^|\/)\.DS_Store$/, new RegExp(`^${LOCK}$`)];

export const writable = (p) => WRITABLE.some((r) => r.test(p));

function files() {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const rel = relative(ROOT, full).split(sep).join("/");
      if (IGNORED.some((r) => r.test(rel) || r.test(`${rel}/`))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(ROOT);
  return out.sort();
}

const digest = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

function locked() {
  return Object.fromEntries(files().filter((p) => !writable(p)).map((p) => [p, digest(p)]));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const mode = isMain ? process.argv[2] : "imported";
if (mode === "imported") {
  // Imported by .claude/hooks/guard-writes.mjs for WRITABLE; nothing runs.
} else if (mode === "--write") {
  const entries = locked();
  writeFileSync(join(ROOT, LOCK), `${JSON.stringify({ format: "lock-v1", files: entries }, null, 2)}\n`);
  process.stdout.write(`locked ${Object.keys(entries).length} files\n`);
} else if (mode === "--verify") {
  let raw, recorded;
  try { raw = readFileSync(join(ROOT, LOCK), "utf8"); recorded = JSON.parse(raw).files; } catch {
    process.stderr.write(`${LOCK} is missing or not JSON; nothing can be verified\n`);
    process.exit(1);
  }
  const now = locked();
  const problems = [];
  // LOCK.json is not in its own list, so it is checked against the copy at the handoff tag:
  // a lock rewritten by hand would otherwise vouch for whatever it was rewritten to match.
  const tagged = spawnSync("git", ["show", `handoff:${LOCK}`], { cwd: ROOT, encoding: "utf8" });
  if (tagged.status !== 0) process.stdout.write(`note: no handoff tag here, so ${LOCK} itself is not checked\n`);
  else if (tagged.stdout !== raw) problems.push(`changed: ${LOCK} differs from the one at the handoff tag`);
  for (const [p, h] of Object.entries(recorded)) {
    if (!(p in now)) problems.push(`removed: ${p}`);
    else if (now[p] !== h) problems.push(`changed: ${p}`);
  }
  for (const p of Object.keys(now)) if (!(p in recorded)) problems.push(`added outside the Code stage's paths: ${p}`);
  if (problems.length) {
    process.stderr.write(`The handoff lock does not hold. The Code stage may write only:\n  agents/security-reviewer/scripts/*.mjs\n  docs/rounds.md\n  README.md\n${problems.map((x) => `  ${x}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`lock holds: ${Object.keys(recorded).length} files unchanged\n`);
} else {
  process.stderr.write("usage: node tools/lock.mjs --write | --verify\n");
  process.exit(2);
}
