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
  assert.equal(findReach("import os\nos.system\n('ls')\n", "python").spawns.length, 0, "a line's end is no call");
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
  const escaped = `\\u0061`; // the identifier a, written as an escape
  const found = findReach(`var ${escaped} = 1; var x = ${escaped} / 1, y = require("./h.js");\n`, "javascript", "x.cjs").imports;
  assert.deepEqual(found.map((i) => i.specifier), ["./h.js"], "an escaped identifier is a value");
});

test("SR-08 findReach reads every reading on its own, and reads JavaScript as Node does", () => {
  const none = [
    ['function f() {}\n/"/ + from /*"./x.js" */\n', "x.js", "no mix of two readings makes up an import"],
    [`x = a${" <!--b".repeat(32)}\n// see https://c6.example/docs\n`, "x.js", "a script or a module, once for the program"],
    ["class C {}\n/'/\n--> fetch(\"https://c7.example\")\n", "x.cjs", "a line starts after a string a reading leaves open"],
    ['const s = "";\ndo `${ {} /[//]/.test(s) ? 0 : "https://c8.example"\n] }`; while (0)\n', "x.mjs", "a substitution holds an expression"],
    [`${String.fromCharCode(0xfeff)}#!/usr/bin/env -S node --title="https://c9.example"\nexport const x = 1;\n`, "x.mjs", "a hashbang after a byte order mark"],
    ['const s = "";\nconst x = 1..in /[//]/.test(s) ? 0 : "https://c10.example"\n];\n', "x.mjs", "a number's own dot, then a member's"],
    ['const s = "";\nconst x = .5.in /[//]/.test(s) ? 0 : "https://c11.example"\n];\n', "x.mjs", "a number that starts with its dot"],
    ['x = a <!-- /*\ny = b <!-- fetch("https://c12.example") */\n', "x.js", "the same reading at every <!--"],
  ];
  for (const [text, path, why] of none) {
    const r = findReach(text, "javascript", path);
    assert.deepEqual([...r.urls, ...r.imports], [], `${why}: ${JSON.stringify(text)}`);
  }
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

// Spec 0.3.0: tests from the planted bugs round 9 found the suite missing.

// reach.mjs: how a JavaScript program reads (reopen 3, js slice)

test("SR-08 findReach reads a / after each kind of closing brace or parenthesis as Node does", () => {
  const at = (line) => [{ host: "in.example", line }];
  const js = [
    ['/"/; // " + fetch("https://out.example")', []],
    ['class A {}\n/[//]/.test(a) && fetch("https://in.example");\n', at(2)],
    ['function f() {}\n/[//]/.test(a) && fetch("https://in.example");\n', at(2)],
    ['x = class {} / "/; // " + fetch("https://in.example");\n', at(1)],
    ['x = function () {} / "/; // " + fetch("https://in.example");\n', at(1)],
    ['try {} catch (e) {}\n/"/; // " + fetch("https://out.example");\n', []],
    ['try {} finally {}\n/"/; // " + fetch("https://out.example");\n', []],
    ['switch (a) { case 1: {} }\n/"/; // " + fetch("https://out.example");\n', []],
    ['{ {}\n/"/; // " + fetch("https://out.example")\n}\n', []],
    ['{}{}\n/"/; // " + fetch("https://out.example")\n', []],
    ['x = a => {}\n/"/; // " + fetch("https://out.example");\n', []],
    ['if (a) {} else {}\n/"/; // " + fetch("https://out.example")\n', []],
    ['do {} while (0)\n/"/; // " + fetch("https://out.example")\n', []],
    ['for (;;) {}\n/"/; // " + fetch("https://out.example")\n', []],
    ['with (a) {}\n/"/; // " + fetch("https://out.example")\n', []],
    ['lbl: {}\n/[//]/.test(a) && fetch("https://in.example");\n', at(2)],
    ['x = { a: {} / "/; // " }; fetch("https://in.example")\n', at(1)],
    ['x = { b: 1 } /[//]/.test(a) ? 0 : "https://out.example"\n];\n', []],
    ['function f() { return {} /[//]/.test(s) ? 0 : "https://out.example"\n] }\n', []],
    ['for (;;) (a) /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a > {} /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = [] /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['function f() {}\n"a" /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
  ];
  for (const [text, urls] of js) assert.deepEqual(findReach(text, "javascript").urls, urls, JSON.stringify(text));
});

test("SR-08 findReach reads template literals as Node does: their text, fields, nesting and escapes", () => {
  const at = (line) => [{ host: "in.example", line }];
  const js = [
    ['const t = `${a}//`; fetch("https://in.example");\n', at(1)],
    ['x = `${ /"/ }`; // " + fetch("https://out.example")\n', []],
    ['x = `${ {} /[//]/.test(a) ? 0 : "https://out.example"\n] }`;\n', []],
    ['const t = `a${ {b:1} }c`; // "https://out.example"\n', []],
    ['const t = `\\`//`; fetch("https://in.example");\n', at(1)],
    ['const t = `a${`b${c}`}d//`; fetch("https://in.example");\n', at(1)],
    ['x = `$${a}`; // "https://out.example"\n', []],
    ['const t = `${/[//]/.test(s) ? 0 : "https://in.example"}`;\n', at(1)],
    ['function f() {}\n`${/"/}`; // " + fetch("https://out.example")\n', []],
    ['x = 1`x`.in /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x.else`${ {} /[//]/.test(s) ? 0 : "https://out.example"\n] }`;\n', []],
    ['"a"`${ {} /[//]/.test(s) ? 0 : "https://out.example"\n] }`;\n', []],
    ['x = {}`${ {} /[//]/.test(s) ? 0 : "https://out.example"\n] }`;\n', []],
  ];
  for (const [text, urls] of js) assert.deepEqual(findReach(text, "javascript").urls, urls, JSON.stringify(text));
});

test("SR-22 findReach reads every import form and literal kind, and no specifier computed at runtime", () => {
  const js = [
    ["x.mjs", "import x from\"./t/a.js\"; export * from'./t/b.js'; import\"./t/c.js\"; import('./t/d.js'); import(\"./t/e.js\" + x); require(`./t/g.js`); import(`./t/h.js`);\n",
      [["./t/a.js", true, 1], ["./t/b.js", true, 1], ["./t/c.js", true, 1], ["./t/d.js", true, 1], ["./t/g.js", false, 1], ["./t/h.js", true, 1]]],
    ["x.cjs", "require('');\nrequire(\"\");\nrequire(``);\nrequire('./\\x74.js');\nrequire('./a\\\r\nb.js');\nrequire(`./\\x74.js`);\nrequire(`./$a.js`);\nrequire('./missing.js');\nrequire(\"./c\\\r\nd.js\");\n",
      [["", false, 1], ["", false, 2], ["", false, 3], ["./t.js", false, 4], ["./ab.js", false, 5], ["./t.js", false, 7], ["./$a.js", false, 8], ["./missing.js", false, 9], ["./cd.js", false, 10]]],
    ["x.cjs", "const n = \"a\";\nrequire(`./t/${n}.js`); import(`./t/${n}.js`); require(\"./ok.js\");\n", [["./ok.js", false, 2]]],
    ["x.js", "x = a <!-- /'/ x++}' from \"./m.js\"\n", []],
  ];
  for (const [path, text, imports] of js) {
    assert.deepEqual(findReach(text, "javascript", path).imports.map((i) => [i.value, i.esm, i.line]), imports, JSON.stringify(text));
  }
});

test("SR-17 findReach counts child_process as a process start, and no module only named like it", () => {
  const like = findReach('require("./child_process"); require("child_process_helper"); require("node:child_processes");\n', "javascript", "x.cjs");
  assert.deepEqual(like.imports.map((i) => i.value), ["./child_process", "child_process_helper", "node:child_processes"]);
  assert.deepEqual(like.spawns, []);
  for (const text of ['require("child_process");\n', 'require("node:child_process");\n', 'import "node:child_process";\n']) {
    assert.equal(findReach(text, "javascript", "x.js").spawns.length, 1, text);
  }
});

test("SR-08 findReach reads the bodies of regular expressions, strings and block comments to where Node ends them", () => {
  const at = (line) => [{ host: "in.example", line }];
  const js = [
    ["x.js", 'const ok = /[/"]/.test(s) ? 0 : "https://in.example";\n', at(1)],
    ["x.js", 'const r = /\\/"/; fetch("https://in.example");\n', at(1)],
    ["x.js", 'const r = /\\//; // "https://out.example"\n', []],
    ["x.js", 'const r = /[a]/; // "https://out.example"\n', []],
    ["x.js", 'const r = /x/*2; fetch("https://in.example");\n', at(1)],
    ["x.js", 'const r = /a/// "https://out.example"\n', []],
    ["x.js", 'const r = /x/g// "https://out.example"\n', []],
    ["x.js", 'const r = /x/g\n/[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ["x.js", 'u = { a: {} / 2 };\n/* "https://out.example" */\n', []],
    ["x.cjs", 'function f() {}\n/[//]/.test(a) && fetch("https://in.example")\nx = function () {} / 2;\ny = 1; // "https://out.example"\n', at(2)],
    ["x.js", 'async function k() { await /[//]/.test(a) && fetch("https://in.example") }\n', at(1)],
    ["x.js", 'const e = ""; // " + fetch("https://out.example")\n', []],
    ["x.js", 'x = "a\\\\"; // " + fetch("https://out.example")\n', []],
    ["x.js", 'const c = "a\\\r\n"; // " + fetch("https://out.example")\n', []],
    ["x.js", "function f() {}\n/'/.test(s);\n// https://out.example\nx = '1';\n", []],
    ["x.js", "function f() {}\n/'/.test(s);\r// https://out.example\rx = '1';\n", []],
    ["x.js", '/*/ "https://out.example" */\n', []],
    ["x.js", '/**/ fetch("https://in.example") /* x */\n', at(1)],
  ];
  for (const [path, text, urls] of js) assert.deepEqual(findReach(text, "javascript", path).urls, urls, JSON.stringify(text));
});

test("SR-22 findReach takes no import from a string a division begins after a function expression, and finds one after a declaration", () => {
  const js = [
    ["x = function () {} / \"/require('./x.js')\"\n", []],
    ["x = class {} / \"/require('./x.js')\"\n", []],
    ["function f() {}\n/\"/; require('./y.js'); // \"\n", [["./y.js", 2]]],
  ];
  for (const [text, imports] of js) {
    assert.deepEqual(findReach(text, "javascript").imports.map((i) => [i.value, i.line]), imports, JSON.stringify(text));
  }
});

test("SR-22 findReach decodes every escape in a specifier to its value", () => {
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  const js = [
    [`require("./\\u0061\\u{62}\\x63\\143\\0\\t\\b\\f\\n\\r\\v\\.\\\\\\'\\"\\/\\\n\\\r\n\\${ls}\\${ps}d.js");\n`, ["./abcc\0\t\b\f\n\r\v.\\'\"/d.js"]],
    ['require("./\\u{61}\\u{062}\\u{10FFFF}.js"); require("./\\u0041\\u00410.js"); require("./\\17\\7\\12\\1\\377\\400.js");\n',
      [`./ab${String.fromCodePoint(0x10ffff)}.js`, "./AA0.js", "./\x0f\x07\n\x01\xff 0.js"]],
    ['require("./test\\5710.js"); require("./\\08.js"); require("./\\38.js"); require("./\\477.js");\n', ["./test/10.js", "./\x008.js", "./\x038.js", "./'7.js"]],
  ];
  for (const [text, values] of js) {
    assert.deepEqual(findReach(text, "javascript", "x.cjs").imports.map((i) => i.value), values, JSON.stringify(text));
  }
});

test("SR-08 findReach merges 32 readings into one answer, and past the cap still finds code, at thousands of points", () => {
  const points = (n) => Array.from({ length: n }, (_, k) => `function f${k}() {}\n/x/;\n`).join("");
  const tail = '// "https://out.example"\nfetch("https://in.example");\n';
  for (const path of ["x.cjs", "x.mjs"]) {
    assert.deepEqual(findReach(`${points(5)}${tail}`, "javascript", path).urls, [{ host: "in.example", line: 12 }], `32 readings of ${path}`);
  }
  for (const [n, path] of [[6, "x.cjs"], [6, "x.mjs"], [400, "x.js"], [4000, "x.js"]]) {
    const r = findReach(`${points(n)}${tail}`, "javascript", path);
    assert.ok(r.urls.some((u) => u.host === "in.example" && u.line === 2 * n + 2), `${n} points in ${path}: ${JSON.stringify(r.urls)}`);
  }
  const at = (line) => [{ host: "in.example", line }];
  const lines = (n) => Array.from({ length: n }, (_, k) => `x${k} = a <!--b\n`).join("");
  const js = [
    ["x.js", `${lines(5)}// "https://out.example"\nfetch("https://in.example")\n`, at(7)],
    ["x.js", `x = a${" <!--b".repeat(32)}\n// "https://out.example"\nfetch("https://in.example")\n`, at(3)],
    ["x.js", `${lines(40)}fetch("https://in.example")\n`, at(41)],
    ["x.js", 'x = a <!-- fetch("https://in.example")\ny = b <!-- c\n', at(1)],
    ["x.cjs", 'x = function () {} / 1; function g() {}\n/[//]/.test(a) && fetch("https://in.example")\n', at(2)],
    ["x.js", "function f() {}\n/'/.test(s);\n// https://out.example\nx = '1';\n", []],
  ];
  for (const [path, text, urls] of js) assert.deepEqual(findReach(text, "javascript", path).urls, urls, JSON.stringify(text));
});

test("SR-09 findReach finds an environment read that any reading takes for code, before, after and past the cap", () => {
  const points = (n) => Array.from({ length: n }, (_, k) => `function f${k}() {}\n/x/;\n`).join("");
  const js = [
    ["process.env.API_KEY;\nfunction f() {}\n/x/;\n", [{ name: "API_KEY", line: 1 }]],
    ["function f() {}\n/[//]/.test(a) && process.env.B_TOKEN;\n", [{ name: "B_TOKEN", line: 2 }]],
    [`${points(4)}function g() {}\n/[//]/.test(a) && process.env.C_TOKEN;\n`, [{ name: "C_TOKEN", line: 10 }]],
    [`${points(6)}function g() {}\n/[//]/.test(a) && process.env.D_TOKEN;\n`, [{ name: "D_TOKEN", line: 14 }]],
  ];
  for (const [text, env] of js) {
    for (const path of ["x.cjs", "x.mjs"]) assert.deepEqual(findReach(text, "javascript", path).env, env, `${path}: ${JSON.stringify(text)}`);
  }
});

test("SR-08 findReach ends its scan at a construct left open at the end of the text, and does not throw", () => {
  const js = [
    ["x.js", "const r = /x/", []],
    ["x.js", "x = function () {} / 2;\ny = 1;\n", []],
    ["x.cjs", '// "https://out.example"\nfunction e5() {}\n/"/.test(s)', []],
    ["x.cjs", '// "https://out.example"\nfunction e3() {}\n/`${/.test(s)', []],
    ["x.cjs", 'z14 = "`";\nx36 = a.return /[//]/.test(s) ? 0 : "https://out.example"\n];\nfunction e3() {}\n/`${/.test(s)', []],
    ["x.js", "function f() {}\n/`/.test(s);\nx = 1;\n", []],
    ["x.cjs", '/* "https://out.example" */\nfunction e4() {}\n/[/*]/.test(s)', []],
  ];
  for (const [path, text, urls] of js) {
    assert.deepEqual(findReach(text, "javascript", path).urls, urls, JSON.stringify(text));
  }
  // Each ends in an open regular expression after a function body; the class expression's division is code.
  const traced = [
    'x12 = `${a}`;\nx30 = class {} / "/; // " + fetch("https://t30.example");\nv16 = "*/";\nfunction f3() {}\n/"/; // " + fetch("https://c3.example");\nfunction e5() {}\n/"/.test(s)',
    'function f42() {}\n/`${/.test(a);\nx12 = `${a}`;\nx6 = function () {}\n/`/; a = 1 // `;\nu17 = { a: {} / 2 };\nx30 = class {} / "/; // " + fetch("https://t30.example");\nfunction e5() {}\n/"/.test(s)',
  ];
  for (const text of traced) {
    const r = findReach(text, "javascript", "x.cjs");
    assert.ok(hosts(r).includes("t30.example"), JSON.stringify(r.urls));
  }
});

test("SR-08 findReach reads a / after each keyword that comes before an expression as a regular expression", () => {
  const at = (line) => [{ host: "in.example", line }];
  const js = [
    ["x.js", 'function f(s) { return /[//]/.test(s) ? 0 : "https://in.example" }\n', at(1)],
    ["x.js", 'x = a instanceof /[//]/.constructor ? 0 : "https://in.example"\n', at(1)],
    ["x.js", 'for (const a of /[//]/.exec(s) ?? []) fetch("https://in.example")\n', at(1)],
    ["x.js", 'x = new /[//]/.constructor("a") ? 0 : "https://in.example"\n', at(1)],
    ["x.js", 'x = delete /[//]/.lastIndex ? 0 : "https://in.example"\n', at(1)],
    ["x.js", 'x = void /[//]/ ? 0 : "https://in.example"\n', at(1)],
    ["x.js", 'if (a) throw /[//]/.test(s) ? 0 : "https://in.example"\n', at(1)],
    ["x.js", 'switch (a) { case /[//]/.source: fetch("https://in.example") }\n', at(1)],
    ["x.js", 'do /[//]/.test(s) ? 0 : fetch("https://in.example"); while (0)\n', at(1)],
    ["x.js", 'if (a) x(); else /[//]/.test(s) ? 0 : fetch("https://in.example")\n', at(1)],
    ["x.js", 'function* g() { yield /[//]/.test(s) ? 0 : "https://in.example" }\n', at(1)],
    ["x.js", 'async function g() { await /[//]/.test(s) ? 0 : "https://in.example" }\n', at(1)],
    ["x.js", 'x = a.of / 2; // "https://out.example"\n', []],
    ["x.cjs", 'x = await /"/; // "; fetch("https://in.example")\n', at(1)],
    ["x.mjs", 'x = await /"/; // "; fetch("https://out.example")\n', []],
    ["x.mjs", 'x = of /"/; // "; fetch("https://in.example")\n', at(1)],
  ];
  for (const [path, text, urls] of js) assert.deepEqual(findReach(text, "javascript", path).urls, urls, `${path}: ${JSON.stringify(text)}`);
});

test("SR-08 findReach reads a / after a member name, a number, ++ or -- as Node does", () => {
  const at = (line) => [{ host: "in.example", line }];
  const js = [
    ['x = "a" in /[//]/ ? 0 : "https://in.example"\n', at(1)],
    ['x = a.b in /[//]/ ? 0 : "https://in.example"\n', at(1)],
    ['x = a.b.in /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a[1].in /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a?.in /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a1.in /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a-- /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = a++ /[//]/.test(s) ? 0 : "https://out.example"\n];\n', []],
    ['x = 1 + /[//]/.test(s) ? 0 : "https://in.example"\n', at(1)],
    ['x++\nfetch("https://in.example")\n', at(2)],
    ['x = a++ /[//]/.test(s) ? 0 : "https://out.example"\n];\nfor (const a of /[//]/.exec(s) ?? []) fetch("https://in.example");\nx = [...typeof /[//]/.test(s) ? "https://in2.example" : 0];\ny = 1; // `\n',
      [{ host: "in.example", line: 3 }, { host: "in2.example", line: 4 }]],
  ];
  for (const [text, urls] of js) assert.deepEqual(findReach(text, "javascript").urls, urls, JSON.stringify(text));
});

test("SR-22 findReach does not take `with` after an operator for a statement's keyword, and finds the require that follows", () => {
  const r = findReach("function f() {}\n/with'x'(a)/ in require('./r.js')// \"https://out.example\"\n`${a}`\n", "javascript");
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.imports.map((i) => [i.value, i.line]), [["./r.js", 2]]);
});

test("SR-08 findReach reads --> in a .cjs program as a comment only at a line's start", () => {
  const js = [
    ['--> fetch("https://out.example")\nx = 1;\n', []],
    ['x = 1; /* a\n */ --> fetch("https://out.example")\n', []],
    ['x = 1;\n--> fetch("https://out.example")\n', []],
    ['x = 1 // c\n--> fetch("https://out.example")\n', []],
    ['x --> fetch("https://in.example")\n', [{ host: "in.example", line: 1 }]],
    ['x = (\na\n) --> fetch("https://in.example")\n', [{ host: "in.example", line: 3 }]],
  ];
  for (const [text, urls] of js) assert.deepEqual(findReach(text, "javascript", "x.cjs").urls, urls, JSON.stringify(text));
});

test("SR-09 findReach reads optional chaining, one-letter names, backticks and destructuring, and only process itself", () => {
  const js = [
    ["a = process.env.ALPHA; b = process?.env.BRAVO; c = process.env?.CHARLIE; d = process?.env?.DELTA; e = process.env.E;\n",
      ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "E"]],
    ["b = process.env['ECHO']; c = process?.env['FOX']; d = process.env?.['GOLF']; e = process.env[\"\"]; f = process.env['']; g = process.env[`HOTEL`];\n",
      ["ECHO", "FOX", "GOLF", "HOTEL"]],
    ["a = myprocess.env.MY_TOKEN; b = myprocess.env['MY_KEY']; c = subprocess.env.SUB;\n", []],
    ["const { A1 } = process?.env; const {B1}=process.env; const {C1} =process.env; const {D1}= process.env; const { E1 } = process.envelope;\n",
      ["A1", "B1", "C1", "D1"]],
  ];
  for (const [text, want] of js) assert.deepEqual(names(findReach(text, "javascript")), want, text);
});

test("SR-08 findReach reads #! as a comment only at the start of the text, and a private name as code", () => {
  const js = [
    ["x.cjs", '#!/usr/bin/env -S node --title="https://out.example"\nx = 1;\n', []],
    ["x.mjs", '#!/usr/bin/env -S node --title="https://out.example"\nexport const x = 1;\n', []],
    ["x.cjs", '(!x) && fetch("https://in.example")\n', [{ host: "in.example", line: 1 }]],
    ["x.cjs", 'class A { #x = "https://in.example" }\n', [{ host: "in.example", line: 1 }]],
  ];
  for (const [path, text, urls] of js) assert.deepEqual(findReach(text, "javascript", path).urls, urls, JSON.stringify(text));
});


// reach.mjs: Python literal names and a JavaScript program's goal (reopen 3, pyrest slice)

test("SR-22 findReach takes no module name from an f-string with a field or from a bytes literal", () => {
  const computed = [`f"{'a'}.tests.b"`, `f"{'tests'}"`, `f"{'a'!r}.tests"`, `F"{'x'}tests"`, 'b"a.tests.b"', 'b"tests"', 'rb"tests"', 'B"tests"', 'Rb"tests"'];
  for (const arg of computed) {
    const text = `import importlib\nimportlib.import_module(${arg})\n`;
    assert.deepEqual(findReach(text, "python").imports.map((i) => i.specifier), ["importlib"], text);
  }
  const literal = 'import importlib\nimportlib.import_module(f"tests")\n';
  assert.deepEqual(findReach(literal, "python").imports.map((i) => [i.specifier, i.line]), [["importlib", 1], ["tests", 2]], "an f-string with no field is a literal name");
});

test("SR-08 findReach takes a program's goal from the ending of its path, not from .cjs or .mjs inside it", () => {
  const html = 'let y = 2;\nlet x = 1 <!--y; fetch("https://a.example");\n';
  const wait = 'let r = await /"/ // " ; "https://a.example"\n';
  const cases = [
    ["lib.cjs.js", html, [{ host: "a.example", line: 2 }]],
    ["lib.cjs.mjs", html, [{ host: "a.example", line: 2 }]],
    ["lib.mjs.cjs", html, []],
    ["lib.mjs.js", wait, [{ host: "a.example", line: 1 }]],
    ["x.mjs.cjs", wait, [{ host: "a.example", line: 1 }]],
    ["x.cjs.mjs", wait, []],
  ];
  for (const [path, text, urls] of cases) assert.deepEqual(findReach(text, "javascript", path).urls, urls, `${path}: ${JSON.stringify(text)}`);
});


// reach.mjs: how a Python program's strings, f-strings and line endings are tokenized (reopen 3, pytok slice)

test("SR-17 findReach finds os.system in every f-string field: in a format spec, after another field, after a slice or dict colon, and after a backslash", () => {
  const text = [
    "import os",
    `s = f"{x:{os.system('a')}}" + f"{x:{w}{os.system('b')}}" + f"{a[1:os.system('c')]}" + f"{ {'k': os.system('d')} }" + f"\\{os.system('e')}"`,
    "",
  ].join("\n");
  assert.deepEqual(findReach(text, "python").spawns.map((s) => s.line), [2, 2, 2, 2, 2], "five calls, each on line 2");
});

test("SR-08 findReach does not count a URL in a comment after an f-string format spec of any shape, and reads the code after it", () => {
  const text = [
    'a = f"{x:}"  # https://c1.example',
    'b = f"{x:{w}>3}"  # https://c2.example',
    'c = f"{x:>10}"  # https://c3.example',
    'd = f"{x:#>10}" + "https://h.example"',
    'e = f"{x:{w:>3}<5}"  # https://c4.example',
    "import subprocess",
    "",
  ].join("\n");
  const r = findReach(text, "python");
  assert.deepEqual(r.urls, [{ host: "h.example", line: 4 }]);
  assert.deepEqual(r.spawns.map((s) => s.line), [6]);
});

// SR-22, spec 0.3.0: a program CPython would reject as a syntax error is read as far as the
// reviewer can read it, and every import and process start found there counts.
test("SR-22 findReach still finds a process start before a Python string, f-string field or format spec left open at the end", () => {
  for (const text of ['import subprocess\ns = f"{x:', 'import subprocess\ns = f"{x', 'import subprocess\ns = "abc']) {
    const r = findReach(text, "python");
    assert.deepEqual(r.imports.map(({ specifier, line }) => [specifier, line]), [["subprocess", 1]], JSON.stringify(text));
    assert.deepEqual(r.spawns.map((s) => s.line), [1], JSON.stringify(text));
  }
});

// SR-22, spec 0.3.0: read as far as the reviewer can read it. Line term: `\n` only.
test("SR-22 findReach ends an unterminated Python string that is not triple-quoted at its line's end, and reads the lines after it", () => {
  const cases = [
    ['s = "abc\nimport subprocess\n', [["subprocess", [], 2]]],
    ["s = 'abc\rimport subprocess\r", [["subprocess", [], 1]]],
    ['import importlib\nimportlib.import_module("tests\n)\n', [["importlib", [], 1], ["tests", [], 2]]],
    ['import importlib\nimportlib.import_module("\\N{x}\n)\n', [["importlib", [], 1], ['"\\N{x}', [], 2]]],
  ];
  for (const [text, imports] of cases) {
    assert.deepEqual(findReach(text, "python").imports.map(({ specifier, names, line }) => [specifier, names, line]), imports, JSON.stringify(text));
  }
  assert.deepEqual(findReach(cases[0][0], "python").spawns.map((s) => s.line), [2]);
  assert.deepEqual(findReach(cases[1][0], "python").spawns.map((s) => s.line), [1]);
});

test("SR-22 findReach names the literal module of an import_module call left unclosed at the end of a Python program", () => {
  const text = 'import importlib\nimportlib.import_module("tests"';
  assert.deepEqual(findReach(text, "python").imports.map(({ specifier, line }) => [specifier, line]), [["importlib", 1], ["tests", 2]]);
});

test("SR-08 findReach keeps a Python string open past an escaped quote or a backslash line ending, so the comment after it does not count", () => {
  const text = [
    's = "\\n\\"x"  # https://c1.example',
    't = f"a\\"b"  # https://c2.example',
    'v = f"\\"}}"  # https://c3.example',
    'u = "a\\\r',
    '"  # https://c4.example',
    "import subprocess",
    "",
  ].join("\n");
  const r = findReach(text, "python");
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.spawns.map((s) => s.line), [6]);
});

test("SR-22 findReach reads r and u literals as module names and rf and fr fields as code, and takes no prefix from a keyword before a quote", () => {
  const text = [
    "import importlib, os",
    "importlib.import_module(r'tests')",
    "importlib.import_module(u'tests.a')",
    `s = rf"{os.system('a')}" + fr"{os.system('b')}"`,
    `x = not"{os.system('c')}"`,
    "def g():",
    `    return"{os.system('d')}"`,
    "",
  ].join("\n");
  const r = findReach(text, "python");
  assert.deepEqual(r.imports.map(({ specifier, line }) => [specifier, line]), [["importlib", 1], ["os", 1], ["tests", 2], ["tests.a", 3]]);
  assert.deepEqual(r.spawns.map((s) => s.line), [4, 4], "the rf and fr fields only");
});

test("SR-17 findReach reads doubled braces in a Python f-string as text, and closes each string where Python does", () => {
  const text = [
    "import os",
    `s = f"{{os.system('ls')}}" + f"{{}}" + f"a{{"  # https://c.example`,
    `t = f"{{{os.system('x')}}}"`,
    "import subprocess",
    "",
  ].join("\n");
  const r = findReach(text, "python");
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.spawns.map((s) => s.line), [3, 4]);
});

// SR-22: every line ending and line continuation. Line term, spec 0.3.0: a lone CR starts no line.
test("SR-22 findReach joins a backslash-CRLF continuation, ends lines at CRLF and a lone CR, and counts lines by line feed only", () => {
  const cases = [
    ["from os \\\r\nimport tests\r\nimport subprocess\r\n", [["os", ["tests"], 1], ["subprocess", [], 3]], [3]],
    ["import os\rimport subprocess\r", [["os", [], 1], ["subprocess", [], 1]], [1]],
    ["\nimport subprocess\n", [["subprocess", [], 2]], [2]],
  ];
  for (const [text, imports, spawns] of cases) {
    const r = findReach(text, "python");
    assert.deepEqual(r.imports.map(({ specifier, names, line }) => [specifier, names, line]), imports, JSON.stringify(text));
    assert.deepEqual(r.spawns.map((s) => s.line), spawns, JSON.stringify(text));
  }
});

test("SR-17 findReach finds a Python import statement after closed brackets, braces and an empty string, and under a tab", () => {
  const text = 'x = [1]\ny = {1: 2}\nimport subprocess\nz = ""\nif x:\n\timport subprocess\n';
  assert.deepEqual(findReach(text, "python").spawns.map((s) => s.line), [3, 6]);
});


// Spec 0.3.0: what the reopen's review found (round 13).

test("SR-08 languageOf reads .mts and .cts as JavaScript and .pyw as Python, in any letter case, and .cts as a script", () => {
  for (const p of ["a.mts", "a.cts", "A.MTS", "b/c.Cts"]) assert.equal(languageOf(p), "javascript", p);
  for (const p of ["a.pyw", "A.PYW"]) assert.equal(languageOf(p), "python", p);
  const text = 'x = 1 <!-- fetch("https://out.example")\nfetch("https://in.example");\n';
  assert.deepEqual(hosts(findReach(text, "javascript", "a.cts")), ["in.example"], "a .cts program is a script, where <!-- begins a comment");
  assert.deepEqual(hosts(findReach(text, "javascript", "a.mts")), ["out.example", "in.example"], "a .mts program is a module, where it does not");
});

test("SR-09 findReach counts a read whose process or env is written with escapes, in brackets or in parentheses, and only process.env itself", () => {
  const BS = "\\";
  const reads = [
    `${BS}u0070rocess.env.A_KEY`, `process.${BS}u0065nv.A_KEY`, `pro${BS}u{63}ess["env"].A_KEY`,
    `process["e${BS}x6ev"].A_KEY`, `process['${BS}u0065nv']?.["A_KEY"]`, `process["${BS}145nv"].A_KEY`,
    "globalThis.process.env.A_KEY", "(process).env.A_KEY", "((process.env)).A_KEY", "(process)?.['env'] [ `A_KEY` ]",
  ];
  for (const read of reads) assert.deepEqual(names(findReach(`const v = ${read};\n`, "javascript", "a.mjs")), ["A_KEY"], read);
  for (const other of ["myprocess.env.A_KEY", "process.envx.A_KEY", "process['envx'].A_KEY", `process["e${BS}x6e"].A_KEY`]) {
    assert.deepEqual(names(findReach(`const v = ${other};\n`, "javascript", "a.mjs")), [], other);
  }
  assert.deepEqual(names(findReach(`const { A_KEY } = ${BS}u0070rocess['env'];\n`, "javascript", "a.mjs")), ["A_KEY"]);
});
