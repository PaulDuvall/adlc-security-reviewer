// The behavioral suite: the reviewer run as a command, one request in, one answer out.
// Each test name starts with the requirement it checks, from docs/spec.md.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT, FAKE, LIMIT, basePackage, expectedDigest, refusal, request, review, rules, run, sha256, tree, writePackage,
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

test("SR-09 does not count a credential-like variable the runtime requirements bind", () => {
  const { answer } = review(basePackage());
  assert.equal(answer?.result, "passed");
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
    kind: "service", credential: "ticket-store-token", leaves: false,
  }]);
  assert.deepEqual(s.spends, { limit: { ...LIMIT }, ceilings: [] });
  assert.ok(s.never.includes("Writing to the ticket store."));
  assert.ok(s.never.includes("Summarizing a ticket it was not handed."));
  assert.ok(s.never.includes("reach any destination outside the systems in reaches"));
  assert.deepEqual(s.accepted_knowingly, []);
  assert.equal(s.decided_by, "rule");
});

test("SR-16 lists every ceiling with the owner's number and the side that enforces it", () => {
  const p = spending([{ system: "ticket-store", per: "task", enforced_by: "platform" }]);
  const { answer } = review(p, { spend_limit: { ...LIMIT }, ceilings: [{ system: "ticket-store", per: "task", most: 25 }] });
  assert.equal(answer?.result, "passed");
  assert.deepEqual(answer.statement.spends.ceilings, [{ system: "ticket-store", per: "task", most: 25, enforced_by: "platform" }]);
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
  for (const item of [/vulnerab/i, /computed at runtime/i, /sufficient/i, /running/i, /test/i]) {
    assert.ok(nc.some((line) => item.test(line)), `names ${item}`);
  }
});

test("SR-18 names a program in a language it does not read", () => {
  const p = { ...basePackage(), "skills/read-tickets/scripts/fetch.sh": "#!/bin/sh\ncurl -s \"$URL\"\n" };
  const nc = review(p).answer?.statement?.not_checked ?? [];
  assert.ok(nc.some((line) => line.includes("skills/read-tickets/scripts/fetch.sh")));
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

// SR-21

test("SR-21 runs with read-only files, no processes and no network", () => {
  const { status, stderr, answer } = review(basePackage());
  assert.equal(status, 0, stderr);
  assert.ok(!stderr.includes("NETWORK"), stderr);
  assert.equal(answer?.result, "passed");
});

test("SR-21 passes its own package with zero declared systems", () => {
  const { answer } = run(request(AGENT, { spend_limit: { most_micro: 0, currency: "USD", per: "day" }, ceilings: [] }));
  assert.equal(answer?.result, "passed", JSON.stringify(answer?.refusals ?? null));
  assert.deepEqual(answer.statement.reaches, []);
  assert.equal(answer.statement.package.name, "security-reviewer");
});
