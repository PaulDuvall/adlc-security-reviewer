#!/usr/bin/env node
// The handoff lock. Everything the Test stage handed over is read-only to the Code stage:
// the statement, the suite, the stand-ins, the harness, the tools and the guardrails. This
// file records the digest of each, and --verify fails when any of them changed, appeared or
// disappeared. Only the paths in WRITABLE may change.
//
//   node tools/lock.mjs --write    record the lock (the spec owner, at handoff)
//   node tools/lock.mjs --verify   check it (every round, and in CI)
//
// Node 22 or later and git, nothing else.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = "LOCK.json";

/** What the Code stage may write: the six programs plugin.json lists, by name, so that no
 *  module is added beside them. Everything else is locked. */
export const WRITABLE = [
  /^agents\/security-reviewer\/scripts\/(?:read-package|reach|secrets|rules|statement|review)\.mjs$/,
  /^docs\/rounds\.md$/,
  /^README\.md$/,
];
export const writable = (p) => WRITABLE.some((r) => r.test(p));

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** The files `git add -A` would commit: every tracked file, and every other file no ignore
 *  rule excludes. A re-lock then commits exactly the files it locks, and a local file that
 *  .gitignore names is never locked. The ceiling keeps git from reading a repository above
 *  this one. A name git cannot hand over as UTF-8 is refused, not dropped. */
function files() {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(ROOT) },
  });
  if (git.status !== 0) fail(`git could not list the files to lock: ${git.stderr?.toString().trim() || git.error?.message}`);
  const names = git.stdout.toString();
  if (!Buffer.from(names).equals(git.stdout)) {
    fail(`a file name is not UTF-8; rename it, then lock or verify:\n${names.split("\0").filter((p) => p.includes(String.fromCharCode(0xfffd))).join("\n")}`);
  }
  return names.split("\0").filter((p) => p && p !== LOCK && present(p)).sort();
}

/** Whether a listed path is in the folder. A tracked file that is missing, or under a folder
 *  now replaced by a file, is not, as git counts it deleted; --verify then names it removed. */
function present(p) {
  try {
    lstatSync(join(ROOT, p));
    return true;
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw e;
  }
}

/** A file's digest. A symbolic link's is of the path it holds, as git stores it. */
function digest(p) {
  const full = join(ROOT, p);
  const entry = lstatSync(full);
  if (entry.isDirectory()) {
    fail(`${p} is a folder where git lists one entry: a repository inside this one, or a file replaced by a folder. Move it out or restore it, then lock or verify`);
  }
  return createHash("sha256").update(entry.isSymbolicLink() ? readlinkSync(full) : readFileSync(full)).digest("hex");
}

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
    process.stderr.write(`The handoff lock does not hold. The Code stage may write only:\n  the six programs in agents/security-reviewer/scripts/\n  docs/rounds.md\n  README.md\n${problems.map((x) => `  ${x}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`lock holds: ${Object.keys(recorded).length} files unchanged\n`);
} else {
  process.stderr.write("usage: node tools/lock.mjs --write | --verify\n");
  process.exit(2);
}
