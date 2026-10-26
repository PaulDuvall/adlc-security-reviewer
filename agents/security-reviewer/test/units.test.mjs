// The unit suite: the functions each program must export, named before any program exists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { readPackage, packageDigest, ships } from "../scripts/read-package.mjs";
import { findReach, isCredentialName, languageOf } from "../scripts/reach.mjs";
import { SECRETS, carriesASecret } from "../scripts/secrets.mjs";
import { FAKE, basePackage, expectedDigest, writePackage } from "./helpers.mjs";

const hosts = (r) => r.urls.map((u) => u.host);
const names = (r) => r.env.map((e) => e.name);

// read-package.mjs

test("SR-05 readPackage reads the descriptor, the runtime requirements and the shipped files", () => {
  const dir = writePackage({ ...basePackage(), "test/x.txt": "not shipped" });
  const pkg = readPackage(dir);
  assert.equal(pkg.descriptor.systems[0].name, "ticket-store");
  assert.equal(pkg.requirements.systems[0].env, "TICKETS_TOKEN");
  assert.deepEqual(pkg.names, { descriptor: "agent-descriptor.json", requirements: "agent-runtime-requirements.json" });
  const paths = pkg.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json",
    "skills/read-tickets/SKILL.md", "skills/read-tickets/scripts/read.mjs",
  ]);
  for (const f of pkg.files) {
    assert.ok(Buffer.isBuffer(f.bytes));
    assert.equal(f.sha256, createHash("sha256").update(f.bytes).digest("hex"));
  }
  assert.equal(pkg.digest, expectedDigest(dir));
});

test("SR-05 readPackage prefers the current names and falls back to the former ones", () => {
  const p = basePackage();
  p["descriptor.json"] = { ...p["agent-descriptor.json"], agent_version: "9.9.9" };
  assert.equal(readPackage(writePackage(p)).descriptor.agent_version, "0.1.0");

  const q = basePackage();
  q["descriptor.json"] = q["agent-descriptor.json"];
  q["install.json"] = q["agent-runtime-requirements.json"];
  q["agent-descriptor.json"] = null;
  q["agent-runtime-requirements.json"] = null;
  const pkg = readPackage(writePackage(q));
  assert.deepEqual(pkg.names, { descriptor: "descriptor.json", requirements: "install.json" });
});

test("SR-05 readPackage throws an error with code unreadable", () => {
  for (const dir of [join(writePackage(basePackage()), "nope"), writePackage({ ...basePackage(), "agent-descriptor.json": "{" })]) {
    assert.throws(() => readPackage(dir), (e) => e.code === "unreadable");
  }
});

test("SR-19 packageDigest follows its definition", () => {
  const files = [
    { path: "b.txt", sha256: "b".repeat(64) },
    { path: "a.txt", sha256: "a".repeat(64) },
  ];
  const lines = `a.txt\0${"a".repeat(64)}\nb.txt\0${"b".repeat(64)}\n`;
  assert.equal(packageDigest(files), `sha256:${createHash("sha256").update(lines).digest("hex")}`);
});

test("ships excludes test folders, node_modules, .git and test files", () => {
  for (const p of ["test/a.mjs", "a/tests/b.py", "node_modules/x/i.js", ".git/config", "scripts/read.test.mjs"]) {
    assert.equal(ships(p), false, p);
  }
  for (const p of ["scripts/read.mjs", "skills/x/SKILL.md", "testing.md", "contest/a.js"]) {
    assert.equal(ships(p), true, p);
  }
});

// reach.mjs

test("languageOf names JavaScript and Python programs, and nothing else", () => {
  for (const p of ["a.mjs", "a.js", "a.cjs", "a.ts"]) assert.equal(languageOf(p), "javascript", p);
  assert.equal(languageOf("a.py"), "python");
  for (const p of ["a.md", "a.json", "a.sh", "Makefile"]) assert.equal(languageOf(p), null, p);
});

test("SR-08 findReach finds URLs in JavaScript code and not in comments", () => {
  const text = [
    "// https://comment.example/one",                         // 1
    'const a = "https://a.example/x"; // https://c.example',  // 2
    "/* https://comment.example/two",                         // 3
    "   https://comment.example/three */",                    // 4
    "const b = `ws://b.example:81/${a}`;",                     // 5
    "const c = 'http://10.1.2.3/metrics';",                   // 6
    "",
  ].join("\n");
  const r = findReach(text, "javascript");
  assert.deepEqual(r.urls, [
    { host: "a.example", line: 2 },
    { host: "b.example", line: 5 },
    { host: "10.1.2.3", line: 6 },
  ]);
});

test("SR-08 findReach finds URLs in Python code and not in comments", () => {
  const text = [
    "# https://comment.example/one",                 // 1
    'URL = "https://p.example/x"  # https://c.example', // 2
    "DOC = '''see wss://q.example/feed'''",          // 3
    "",
  ].join("\n");
  assert.deepEqual(findReach(text, "python").urls, [
    { host: "p.example", line: 2 },
    { host: "q.example", line: 3 },
  ]);
});

test("SR-09 findReach finds every environment read form in JavaScript", () => {
  const text = [
    "const a = process.env.ALPHA;",
    'const b = process.env["BRAVO"];',
    "const c = process.env['CHARLIE'];",
    "const { DELTA, ECHO: echo } = process.env;",
    "// process.env.IN_A_COMMENT",
    "",
  ].join("\n");
  assert.deepEqual(findReach(text, "javascript").env, [
    { name: "ALPHA", line: 1 },
    { name: "BRAVO", line: 2 },
    { name: "CHARLIE", line: 3 },
    { name: "DELTA", line: 4 },
    { name: "ECHO", line: 4 },
  ]);
});

test("SR-09 findReach finds every environment read form in Python", () => {
  const text = [
    "import os",
    'a = os.getenv("ALPHA")',
    "b = os.environ['BRAVO']",
    'c = os.environ.get("CHARLIE", "x")',
    '# os.getenv("IN_A_COMMENT")',
    "",
  ].join("\n");
  assert.deepEqual(names(findReach(text, "python")), ["ALPHA", "BRAVO", "CHARLIE"]);
});

test("SR-17 findReach finds process starts", () => {
  assert.equal(findReach('import { spawn } from "node:child_process";\n', "javascript").spawns.length, 1);
  assert.equal(findReach('const cp = require("child_process");\n', "javascript").spawns.length, 1);
  assert.equal(findReach("import subprocess\n", "python").spawns.length, 1);
  assert.equal(findReach("import os\nos.system('ls')\n", "python").spawns.length, 1);
  assert.equal(findReach("export const x = 1;\n", "javascript").spawns.length, 0);
  assert.deepEqual(hosts(findReach("export const x = 1;\n", "javascript")), []);
});

test("isCredentialName reads the parts of a name", () => {
  for (const n of ["TEXT_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "my_secret", "GH_PAT", "AWS_CREDENTIALS", "BASIC_AUTH", "PASSWD"]) {
    assert.equal(isCredentialName(n), true, n);
  }
  for (const n of ["AUTHOR_NAME", "TOKENIZER_PATH", "KEYBOARD_LAYOUT", "LOG_LEVEL", "TEXT_MODEL", "DRAFT_HOST_URL"]) {
    assert.equal(isCredentialName(n), false, n);
  }
});

// secrets.mjs

test("SR-13 SECRETS carries the publisher's credential patterns", () => {
  assert.ok(SECRETS.length >= 7);
  for (const s of SECRETS) {
    assert.equal(typeof s.what, "string");
    assert.ok(s.find instanceof RegExp);
  }
});

test("SR-13 carriesASecret names the kind of credential, and passes ordinary text", () => {
  assert.equal(carriesASecret(Buffer.from(`${FAKE.privateKeyHeader()}\nAAAA\n`)), "a private key");
  assert.equal(carriesASecret(Buffer.from(`id = ${FAKE.awsAccessKey()}\n`)), "an AWS access key");
  assert.equal(carriesASecret(Buffer.from("This page explains how a secret key is rotated.\n")), null);
  assert.equal(carriesASecret(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), null);
});
