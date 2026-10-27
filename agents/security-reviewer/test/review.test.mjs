// The behavioral suite: the reviewer run as a command, one request in, one answer out.
// Each test name starts with the requirement it checks, from docs/spec.md.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

test("SR-22 does not count import text inside a Python f-string or a continued string", () => {
  const p = basePackage();
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
