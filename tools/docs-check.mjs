#!/usr/bin/env node
// The documented commands, run as written. Each reviewer command in a bash block of README.md
// or examples/README.md runs through bash from the repository's root, and its answer must equal
// the one recorded in examples/answers. The loop that records the answers runs into a temporary
// folder, never into examples/answers, and must rebuild every recorded answer. Each JSON answer
// a document shows must equal a recorded answer; a digest it shortens with "…" must start the
// recorded one. A command that reads the reader's own request.json is skipped. A reviewer
// command of any other form fails the check, so a new form is never passed over unseen. Other
// commands are not run: git clone needs the network, and npm run verify runs this check.
//
//   node tools/docs-check.mjs
//
// Node 22 or later and bash. CI runs it in the Code stage only: the empty stand-ins give no
// recorded answer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "examples/README.md"];
const ANSWERS = "examples/answers";
const READERS_OWN = /<\s*request\.json\s*$/;
const ONE_REQUEST = /<\s*(examples\/requests\/[\w.-]+\.json)\s*$/;
const RECORD_TARGET = /"examples\/answers\/\$\(basename "\$r"\)"/;
const SHORTENED = "…";

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const answerNames = () => readdirSync(join(ROOT, ANSWERS)).filter((f) => f.endsWith(".json")).sort();
const recorded = (name) => JSON.parse(read(`${ANSWERS}/${name}`));

/** @param {string} script @returns {string} what bash wrote to standard output */
function bash(script) {
  return execFileSync("bash", ["-o", "pipefail", "-c", script], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} doc @param {string} lang @returns {string[]} the bodies of its fenced blocks */
function blocks(doc, lang) {
  return [...read(doc).matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
}

/** @param {string} doc @returns {string[]} each line of a bash block that runs the reviewer */
function reviewerCommands(doc) {
  return blocks(doc, "bash").flatMap((b) => b.split("\n")).map((l) => l.trim()).filter((l) => l.includes("review.mjs"));
}

/** @returns {string|null} a problem, or null when the answer is the recorded one */
function checkOneRequest(cmd, request) {
  const name = basename(request);
  return isDeepStrictEqual(JSON.parse(bash(cmd)), recorded(name)) ? null : `${cmd}\n    gives an answer other than ${ANSWERS}/${name}`;
}

/** @returns {string|null} a problem, or null when the loop rebuilds every recorded answer */
function checkRecordLoop(cmd) {
  const dir = mkdtempSync(join(tmpdir(), "docs-check-"));
  try {
    bash(cmd.replace(RECORD_TARGET, () => `"${dir}/$(basename "$r")"`));
    const want = answerNames();
    const built = readdirSync(dir).sort();
    if (!isDeepStrictEqual(built, want)) return `the recording loop wrote ${built.join(", ")}, not ${want.join(", ")}`;
    const differ = want.filter((n) => readFileSync(join(dir, n), "utf8") !== read(`${ANSWERS}/${n}`));
    return differ.length ? `the recording loop gives other answers for ${differ.join(", ")}` : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @returns {["run"|"skipped", string|null]} what the command is, and its problem if any */
function checkCommand(cmd) {
  if (READERS_OWN.test(cmd)) return ["skipped", null];
  const one = ONE_REQUEST.exec(cmd);
  if (one) return ["run", checkOneRequest(cmd, one[1])];
  if (RECORD_TARGET.test(cmd)) return ["run", checkRecordLoop(cmd)];
  return ["run", `${cmd}\n    is a reviewer command this check cannot run; add its form to tools/docs-check.mjs`];
}

/** A failed command is itself the finding, so any error it throws is reported, not raised. */
function attempt(cmd) {
  try { return checkCommand(cmd); } catch (e) {
    const why = (e.stderr?.toString() || e.message).trim().split("\n")[0];
    return ["run", `${cmd}\n    failed: ${why}`];
  }
}

/** Whether a shown answer equals a recorded one, a digest ending "…" standing for its start. */
function matches(shown, rec) {
  const short = shown.package?.digest;
  if (typeof short !== "string" || !short.endsWith(SHORTENED)) return isDeepStrictEqual(shown, rec);
  const full = rec.package?.digest;
  if (typeof full !== "string" || !full.startsWith(short.slice(0, -SHORTENED.length))) return false;
  return isDeepStrictEqual({ ...shown, package: { ...shown.package, digest: full } }, rec);
}

/** @returns {{count: number, problems: string[]}} the JSON answers a document shows, checked */
function checkShownAnswers(doc) {
  const answers = answerNames().map(recorded);
  const shown = blocks(doc, "json").map((b) => JSON.parse(b)).filter((v) => v && typeof v === "object" && "result" in v);
  const problems = shown.filter((s) => !answers.some((a) => matches(s, a))).map((s) => `shows a "${s.result}" answer that matches none in ${ANSWERS}`);
  return { count: shown.length, problems };
}

function main() {
  const problems = [];
  const tally = { run: 0, skipped: 0, shown: 0 };
  for (const doc of DOCS) {
    for (const cmd of reviewerCommands(doc)) {
      const [kind, problem] = attempt(cmd);
      tally[kind] += 1;
      if (problem) problems.push(`${doc}: ${problem}`);
    }
    const shown = checkShownAnswers(doc);
    tally.shown += shown.count;
    problems.push(...shown.problems.map((p) => `${doc}: ${p}`));
  }
  if (tally.run === 0) problems.push("no documented reviewer command was found to run");
  if (problems.length) {
    process.stderr.write(`The documented commands do not hold:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`documented commands work: ${tally.run} run as written, ${tally.skipped} skipped (the reader's own request), ${tally.shown} shown answer matched\n`);
}

main();
