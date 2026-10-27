// The unit suite: the functions each program must export, named before any program exists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { CREDENTIALS, FAKE, basePackage, expectedDigest, writePackage } from "./helpers.mjs";

// Frozen before the programs load, so a program under test cannot replace the assertions it
// is checked with.
Object.freeze(assert);
const { readPackage, packageDigest, ships } = await import("../scripts/read-package.mjs");
const { findReach, isCredentialName, languageOf } = await import("../scripts/reach.mjs");
const { SECRETS, carriesASecret } = await import("../scripts/secrets.mjs");

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

  // U+FF21 sorts before U+1F600 by UTF-8 bytes, and after it by UTF-16 code units.
  const wide = `${String.fromCodePoint(0xff21)}.txt`;
  const astral = `${String.fromCodePoint(0x1f600)}.txt`;
  const odd = [{ path: astral, sha256: "c".repeat(64) }, { path: wide, sha256: "d".repeat(64) }];
  const bytewise = `${wide}\0${"d".repeat(64)}\n${astral}\0${"c".repeat(64)}\n`;
  assert.equal(packageDigest(odd), `sha256:${createHash("sha256").update(bytewise).digest("hex")}`, "paths sort by bytes");
});

test("SR-19 ships excludes test folders, node_modules, .git and test files", () => {
  for (const p of ["test/a.mjs", "a/tests/b.py", "node_modules/x/i.js", ".git/config", "scripts/read.test.mjs"]) {
    assert.equal(ships(p), false, p);
  }
  for (const p of ["scripts/read.mjs", "skills/x/SKILL.md", "testing.md", "contest/a.js"]) {
    assert.equal(ships(p), true, p);
  }
});

// reach.mjs

test("SR-08 languageOf names JavaScript and Python programs, and nothing else", () => {
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

test("SR-08 findReach ends comments where each language ends them, and keeps strings and regular expressions whole", () => {
  const ls = String.fromCharCode(0x2028);
  const js = [
    ["const d = a / b; // https://c1.example", []],
    ["if (x) /'/.test(y); // https://c2.example", []],
    ["{ }\n/'/.test(y); // https://c3.example", []],
    ['#!/usr/bin/env node\nconst u = "https://h1.example";', [{ host: "h1.example", line: 2 }]],
    ['const s = "a \\" // https://h2.example";', [{ host: "h2.example", line: 1 }]],
    ["const t = `${`https://h3.example`}`;", [{ host: "h3.example", line: 1 }]],
    ['const s = "see:\\nhttps://h4.example";', [{ host: "h4.example", line: 1 }]],
    ['const u = "HTTPS://H5.Example.COM:8443/x";', [{ host: "h5.example.com", line: 1 }]],
    [`// c${ls}fetch("https://h6.example");`, [{ host: "h6.example", line: 1 }]],
    ['// c\rfetch("https://h7.example");', [{ host: "h7.example", line: 1 }]],
    ['const u = "https://redis_cache:6379/";', [{ host: "redis_cache", line: 1 }]],
    ['export default /[/*]/;\nfetch("https://h8.example");\n// */', [{ host: "h8.example", line: 2 }]],
    ["const q = x.default / 2; // https://c4.example", []],
    ['const a = [...typeof /[/*]/];\nfetch("https://h9.example");\n// */', [{ host: "h9.example", line: 2 }]],
    ['const b = 1. in /[/*]/;\nfetch("https://h10.example");\n// */', [{ host: "h10.example", line: 2 }]],
    ['class A { #return = 4; h() { return this.#return / 2 + "//*"; } }\nfetch("https://h11.example");\n// */', [{ host: "h11.example", line: 2 }]],
    [`const a${String.fromCharCode(0x200c)}default = 4; const h = a${String.fromCharCode(0x200c)}default / 2 + "//*";\nfetch("https://h12.example");\n// */`, [{ host: "h12.example", line: 2 }]],
    ['const s = "a\\\r\nb"; fetch("https://h13.example");', [{ host: "h13.example", line: 2 }]],
  ];
  for (const [text, urls] of js) assert.deepEqual(findReach(text, "javascript").urls, urls, text);
  const py = [
    ['s = "# not a comment https://p1.example"', [{ host: "p1.example", line: 1 }]],
    ['# c\ru = "https://p2.example"', [{ host: "p2.example", line: 1 }]],
    ["x = 1  # https://no.example", []],
  ];
  for (const [text, urls] of py) assert.deepEqual(findReach(text, "python").urls, urls, text);
});

test("SR-09 findReach finds every environment read form in JavaScript", () => {
  const text = [
    "const a = process.env.ALPHA;",
    'const b = process.env["BRAVO"];',
    "const c = process.env['CHARLIE'];",
    "const { DELTA, ECHO: echo } = process.env;",
    "// process.env.IN_A_COMMENT",
    "const f = process",
    "  .env.FOXTROT;",
    "const g = process/* c */.env.GOLF;",
    "",
  ].join("\n");
  assert.deepEqual(findReach(text, "javascript").env, [
    { name: "ALPHA", line: 1 },
    { name: "BRAVO", line: 2 },
    { name: "CHARLIE", line: 3 },
    { name: "DELTA", line: 4 },
    { name: "ECHO", line: 4 },
    { name: "FOXTROT", line: 6 },
    { name: "GOLF", line: 8 },
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
  assert.equal(findReach("if True: import subprocess\n", "python").spawns.length, 1);
  assert.equal(findReach("x = 1; import subprocess\n", "python").spawns.length, 1);
  assert.equal(findReach('import os; s = "subprocess"\n', "python").spawns.length, 0);
  assert.equal(findReach('const cp = require("child\\x5fprocess");\n', "javascript").spawns.length, 1);
  assert.equal(findReach('const s = "require(\'child_process\')";\n', "javascript").spawns.length, 0);
  assert.equal(findReach(`${String.fromCharCode(0xfeff)}import subprocess\n`, "python").spawns.length, 1);
  assert.equal(findReach('s = "import subprocess"\n', "python").spawns.length, 0);
  assert.equal(findReach("export const x = 1;\n", "javascript").spawns.length, 0);
  assert.deepEqual(hosts(findReach("export const x = 1;\n", "javascript")), []);
});

test("SR-09 isCredentialName reads the parts of a name", () => {
  for (const n of ["TEXT_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "my_secret", "GH_PAT", "AWS_CREDENTIALS", "BASIC_AUTH", "PASSWD", "TOKEN_FILE", "AWS_CREDENTIAL"]) {
    assert.equal(isCredentialName(n), true, n);
  }
  for (const n of ["AUTHOR_NAME", "TOKENIZER_PATH", "KEYBOARD_LAYOUT", "LOG_LEVEL", "TEXT_MODEL", "DRAFT_HOST_URL", "API-KEY"]) {
    assert.equal(isCredentialName(n), false, n);
  }
});

test("SR-22 findReach finds every import, re-export and require, and none a literal only contains", () => {
  const js = [
    'import a from "./a.mjs";',
    'export { "b" } from "./b.mjs";',
    "import {",
    "  c,",
    '} from "./c.mjs";',
    'const d = await import("./d.mjs", {});',
    'const e = require?.("./e.js",);',
    'const f = require("./" + name);',
    "const g = \"require('./g.js')\";",
    'const h = `import h from "./h.mjs"`;',
    "export default /[/*]/;",
    'import "./i.mjs"; // */',
  ].join("\n");
  assert.deepEqual(findReach(js, "javascript").imports.map(({ specifier, esm, line }) => [specifier, esm, line]), [
    ["./a.mjs", true, 1], ["./b.mjs", true, 2], ["./c.mjs", true, 5], ["./d.mjs", true, 6], ["./e.js", false, 7], ["./i.mjs", true, 12],
  ]);
  assert.equal(findReach('import "./\\x74est/j.mjs";', "javascript").imports[0]?.value, "./test/j.mjs");
  const py = [
    "from . import tests",
    "from .a.b import (c,",
    "    d as e)",
    "import f.g as h, i",
    's = "from .j import k"',
    "if x: from .. l import m",
  ].join("\n");
  assert.deepEqual(findReach(py, "python").imports.map(({ specifier, names, line }) => [specifier, names, line]), [
    [".", ["tests"], 1], [".a.b", ["c", "d"], 2], ["f.g", [], 4], ["i", [], 4], ["..l", ["m"], 6],
  ]);
});

test("SR-22 findReach reads every way a `/` or an HTML-like comment may be read, so none hides an import", () => {
  const js = [
    ["let of = 2;\nlet x = of / 1, y = import(\"./a.mjs\");\n", "./a.mjs", 2],
    ["var yield = 2; var x = yield / 1, y = require(\"./b.js\");\n", "./b.js", 1],
    ["const z = {} / require(\"./c.js\");\n", "./c.js", 1],
    ["let a = 1; const w = a++ / 1, y = import(\"./d.mjs\");\n", "./d.mjs", 1],
    ["const v = obj.if(1) / 1, y = import(\"./e.mjs\");\n", "./e.mjs", 1],
    ["const x = 1 <!-- `\nrequire(\"./f.js\");\n// `\n", "./f.js", 2],
  ];
  for (const [text, specifier, line] of js) {
    const found = findReach(text, "javascript").imports.find((i) => i.specifier === specifier);
    assert.equal(found?.line, line, text);
  }
  assert.deepEqual(findReach("var m = 1; <!-- require(\"./g.js\")\n", "javascript", "x.cjs").imports, [], "in a script, <!-- begins a comment");
  assert.deepEqual(findReach("if (x) { }\n/'/.test(y); // https://c5.example\n", "javascript").urls, [], "a block's } leaves no doubt");
});

// secrets.mjs

test("SR-13 SECRETS carries the publisher's credential patterns", () => {
  assert.ok(SECRETS.length >= 7);
  for (const s of SECRETS) {
    assert.equal(typeof s.what, "string");
    assert.ok(s.find instanceof RegExp);
  }
  assert.deepEqual([...new Set(SECRETS.map((s) => s.what))].sort(), [
    "a PKCS#12 keystore", "a private key", "a service-account key", "an AWS access key", "an AWS secret key", "an NKey seed",
  ]);
});

test("SR-13 carriesASecret names each kind in the publisher's list", () => {
  for (const c of CREDENTIALS()) assert.equal(carriesASecret(Buffer.from(c.text)), c.what, c.what);
});

test("SR-13 carriesASecret names the kind of credential, and passes ordinary text", () => {
  assert.equal(carriesASecret(Buffer.from(`${FAKE.privateKeyHeader()}\nAAAA\n`)), "a private key");
  assert.equal(carriesASecret(Buffer.from(`id = ${FAKE.awsAccessKey()}\n`)), "an AWS access key");
  assert.equal(carriesASecret(Buffer.from("This page explains how a secret key is rotated.\n")), null);
  assert.equal(carriesASecret(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), null);
});
