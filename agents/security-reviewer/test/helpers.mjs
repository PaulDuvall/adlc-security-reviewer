// Shared by the suite. Locked with it: the Code stage reads this file and never changes it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const AGENT = join(ROOT, "agents", "security-reviewer");
export const REVIEW = join(AGENT, "scripts", "review.mjs");
const NO_NETWORK = join(AGENT, "test", "no-network.mjs");

// Credentials are assembled at run time so that no literal credential sits in this
// repository, where a scanner would rightly refuse it.
export const FAKE = {
  awsAccessKey: () => ["AK", "IA", "QQQQ", "EXAMPLE0", "ABCD"].join(""),
  privateKeyHeader: () => ["-----BEGIN ", "PRIVATE", " KEY-----"].join(""),
};

/** One sample of each kind in the publisher's list, assembled at run time like FAKE.
 *  `secret` is the part no answer may repeat. */
export function CREDENTIALS() {
  const pem = ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join("");
  const encrypted = ["-----BEGIN ", "ENCRYPTED PRIVATE", " KEY-----"].join("");
  const awsSecret = ["aws_secret", "_access_key = ", "Kx9vQ2mZ7pL4", "nR8sT1wY3uB6", "cD5eF0gH2jK4"].join("");
  const nkey = ["S", "U", "A2B3C4D5E6F7G2H3".repeat(3), "IJKLMNOP"].join("");
  const typeLine = ['"type"', ': "service', '_account"'].join("");
  const keyLine = ['"private', '_key": "-----BEGIN', '\\nMIIEvQ"'].join("");
  return [
    { what: "a private key", text: `${pem}\nMIIEowIBAAKCAQEA\n`, secret: pem },
    { what: "a service-account key", text: `{ ${typeLine} }\n`, secret: typeLine },
    { what: "a service-account key", text: `{ ${keyLine} }\n`, secret: keyLine },
    { what: "an AWS access key", text: `id = ${FAKE.awsAccessKey()}\n`, secret: FAKE.awsAccessKey() },
    { what: "an AWS secret key", text: `${awsSecret}\n`, secret: awsSecret },
    { what: "an NKey seed", text: `seed ${nkey} here\n`, secret: nkey },
    { what: "a PKCS#12 keystore", text: `${encrypted}\nMIIFHz\n`, secret: encrypted },
  ];
}

export const LIMIT = Object.freeze({ most_micro: 1000000, currency: "USD", per: "day" });

const PROGRAM = [
  "// Reads tickets from the store the host binds. Roles: https://agentroles.ai/",
  "const token = process.env.TICKETS_TOKEN;",
  "const base = process.env.TICKETS_URL;",
  "",
  "export async function read(id) {",
  "  const r = await fetch(`${base}/tickets/${id}`, { headers: { authorization: `Bearer ${token}` } });",
  "  return r.json();",
  "}",
  "",
].join("\n");

/** A package that should pass: one system at read access, with a reason, reached only
 *  through the credential and setting its runtime requirements bind. */
export function basePackage() {
  return {
    "plugin.json": { name: "ticket-reader", version: "0.1.0" },
    "agent-descriptor.json": {
      format: "agent-descriptor-v1",
      agent_version: "0.1.0",
      does: "Reads support tickets and summarizes them.",
      offerings: [],
      refusals: "Writing to the ticket store.\nSummarizing a ticket it was not handed.",
      records: [],
      systems: [{ name: "ticket-store", access: "read", needs: "to read the tickets it summarizes" }],
    },
    "agent-runtime-requirements.json": {
      format: "agent-runtime-requirements-v1",
      runtimes: [{ name: "node", version: ">=22" }],
      binaries: [],
      dependencies: [],
      systems: [{
        name: "ticket-store",
        kind: "service",
        credential: "ticket-store-token",
        env: "TICKETS_TOKEN",
        settings: [{ env: "TICKETS_URL", purpose: "where the ticket store answers" }],
      }],
      ceilings: [],
      directories: [],
      job_seconds: 60,
    },
    "skills/read-tickets/SKILL.md": "# Read tickets\n",
    "skills/read-tickets/scripts/read.mjs": PROGRAM,
  };
}

/** Write a package to a fresh directory. Objects become pretty JSON; strings are written
 *  as they are; null leaves the file out. */
export function writePackage(files, name = "ticket-reader") {
  const dir = join(mkdtempSync(join(tmpdir(), "sr-")), name);
  for (const [path, body] of Object.entries(files)) {
    if (body === null) continue;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" || Buffer.isBuffer(body) ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
}

export function request(packageDir, owner = { spend_limit: { ...LIMIT }, ceilings: [] }, extra = {}) {
  return { review: "v1", ask: "review", package: packageDir, owner, ...extra };
}

/** Run the reviewer as a command, the way a host would, under Node's permission model:
 *  it may read any file, and may not write one, start a process or open a connection. */
export function run(input, cwd = ROOT) {
  const body = typeof input === "string" ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [
    "--permission", "--allow-fs-read=*", "--import", NO_NETWORK, REVIEW,
  ], { input: body, encoding: "utf8", cwd, timeout: 20000 });
  let answer = null;
  try { answer = JSON.parse(r.stdout); } catch { /* left null; the test says why */ }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", answer };
}

export function review(files, owner, extra) {
  const dir = writePackage(files);
  return { dir, ...run(request(dir, owner, extra)) };
}

export const rules = (answer) => (answer?.refusals ?? []).map((r) => r.rule);

export function refusal(answer, rule, system) {
  return (answer?.refusals ?? []).find((r) => r.rule === rule && (system === undefined || r.system === system));
}

/** Every file under a directory, test folders included, with its digest. */
export function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** The package digest, computed from its definition in docs/spec.md, independently of
 *  the program under test. */
export function expectedDigest(dir) {
  const skip = (p) => p.split("/").some((s) => ["test", "tests", "node_modules", ".git"].includes(s))
    || /\.test\./.test(p.split("/").pop());
  const lines = Object.entries(tree(dir))
    .filter(([p]) => !skip(p))
    .sort(([a], [b]) => (Buffer.compare(Buffer.from(a), Buffer.from(b))))
    .map(([p, h]) => `${p}\0${h}\n`)
    .join("");
  return `sha256:${createHash("sha256").update(lines).digest("hex")}`;
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
