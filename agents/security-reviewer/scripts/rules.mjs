// Check the declaration and the owner's limits against what the package holds (SR-06 to
// SR-14), and say what was accepted knowingly (SR-17) and what was not checked (SR-18).
import { findReach, isCredentialName, languageOf } from "./reach.mjs";
import { secretsIn } from "./secrets.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const blank = (v) => typeof v !== "string" || !v.trim();

/** A refusal, its members always in the same order. */
function refuse(rule, why, { system, file, line } = {}) {
  const r = { rule };
  if (system !== undefined) r.system = system;
  if (file !== undefined) r.file = file;
  if (line !== undefined) r.line = line;
  r.why = why;
  return r;
}

// What the package declares

const descriptorSystems = (pkg) => list(pkg.descriptor.systems).filter((s) => typeof s.name === "string");
const requiredSystems = (pkg) => list(pkg.requirements.systems).filter((s) => typeof s.name === "string");
const ceilings = (pkg) => list(pkg.requirements.ceilings);

/** Every environment variable the runtime requirements bind, as a credential or a setting. */
function boundNames(pkg) {
  const names = new Set();
  for (const s of list(pkg.requirements.systems)) {
    if (typeof s.env === "string") names.add(s.env);
    for (const setting of list(s.settings)) if (typeof setting.env === "string") names.add(setting.env);
  }
  return names;
}

const programsRead = new WeakMap();

/** Each shipped program with what it reaches, read once per package. */
function programs(pkg) {
  if (!programsRead.has(pkg)) {
    const found = [];
    for (const f of pkg.files) {
      const language = languageOf(f.path);
      if (language) found.push({ path: f.path, reach: findReach(f.bytes.toString("utf8"), language) });
    }
    programsRead.set(pkg, found);
  }
  return programsRead.get(pkg);
}

// The owner's limits

const CURRENCY = /^[A-Z]{3}$/;
const PERIODS = new Set(["task", "day"]);

/** The owner's spending limit as the owner gave it, so the statement's limit equals it
 *  (SR-16), or null when missing or malformed. */
export function limitOf(owner) {
  const l = isObject(owner) ? owner.spend_limit : undefined;
  if (!isObject(l)) return null;
  if (!Number.isSafeInteger(l.most_micro) || l.most_micro < 0) return null;
  if (typeof l.currency !== "string" || !CURRENCY.test(l.currency)) return null;
  if (!PERIODS.has(l.per)) return null;
  return { ...l };
}

/** The owner's number for a ceiling: the first entry with its system and period whose
 *  `most` is a non-negative number. Null when there is none. */
export function ownerNumber(owner, ceiling) {
  const set = isObject(owner) ? list(owner.ceilings) : [];
  const match = set.find((o) => o.system === ceiling.system && o.per === ceiling.per
    && typeof o.most === "number" && Number.isFinite(o.most) && o.most >= 0);
  return match ? match.most : null;
}

export function spendLimitRefusals(owner) {
  if (limitOf(owner)) return [];
  const why = isObject(owner) && owner.spend_limit !== undefined
    ? "the owner's spending limit is malformed: most_micro must be a non-negative integer, currency three uppercase letters, per task or day"
    : "the owner set no spending limit";
  return [refuse("spend-limit", why)];
}

// The rules, in the order the statement lists them

function systemsMismatch(pkg) {
  const inDescriptor = new Set(descriptorSystems(pkg).map((s) => s.name));
  const inRequirements = new Set(requiredSystems(pkg).map((s) => s.name));
  const only = (a, b, where, other) => [...a].filter((n) => !b.has(n)).map((system) => refuse("systems-mismatch",
    `${system} is named in ${where} and not in ${other}`, { system }));
  return [
    ...only(inDescriptor, inRequirements, pkg.names.descriptor, pkg.names.requirements),
    ...only(inRequirements, inDescriptor, pkg.names.requirements, pkg.names.descriptor),
  ];
}

function noReason(pkg) {
  return descriptorSystems(pkg).filter((s) => blank(s.needs)).map((s) => refuse("no-reason",
    `the descriptor records no reason (needs) for reaching ${s.name}`, { system: s.name }));
}

function undeclaredReach(pkg) {
  const bound = boundNames(pkg);
  const out = [];
  for (const p of programs(pkg)) {
    const found = [
      ...p.reach.urls.map((u) => ({ line: u.line, r: refuse("undeclared-reach",
        `the program reaches ${u.host} by a URL in its code, not through a system the host binds`,
        { system: u.host, file: p.path, line: u.line }) })),
      ...p.reach.env.filter((e) => !bound.has(e.name) && isCredentialName(e.name)).map((e) => ({ line: e.line, r: refuse("undeclared-reach",
        `the program reads the credential-like variable ${e.name}, which the runtime requirements do not bind`,
        { system: e.name, file: p.path, line: e.line }) })),
    ];
    out.push(...found.sort((a, b) => a.line - b.line).map((x) => x.r));
  }
  return out;
}

const ENFORCERS = new Set(["runtime", "platform"]);

function ceilingMissing(pkg) {
  const capped = new Set(ceilings(pkg).map((c) => c.system));
  const spending = requiredSystems(pkg).filter((s) => Object.hasOwn(s, "spends"));
  return [
    ...spending.filter((s) => !capped.has(s.name)).map((s) => refuse("ceiling-missing",
      `${s.name} spends, and the runtime requirements set no ceiling on it`, { system: s.name })),
    ...ceilings(pkg).filter((c) => !ENFORCERS.has(c.enforced_by)).map((c) => refuse("ceiling-missing",
      `the ceiling on ${c.system} per ${c.per} does not say whether the runtime or the platform enforces it`, { system: c.system })),
  ];
}

function ceilingUnset(pkg, owner) {
  return ceilings(pkg).filter((c) => ownerNumber(owner, c) === null).map((c) => refuse("ceiling-unset",
    `the owner set no number for the ceiling on ${c.system} per ${c.per}`, { system: c.system }));
}

function credentialInFiles(pkg) {
  return pkg.files.flatMap((f) => secretsIn(f.bytes).map((s) => refuse("credential-in-files",
    `the file carries ${s.what}; its value is not repeated here`, { file: f.path, line: s.line })));
}

const NPM_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const isNpmLockfile = (path) => NPM_LOCKFILES.has(path.split("/").pop());
const lockfilePath = (entry) => (typeof entry.lockfile === "string" && entry.lockfile.trim()
  ? entry.lockfile.trim().replace(/^(?:\.\/)+/, "") : null);

/** The entries under `packages`, other than the root, that carry no integrity. */
function unpinnedEntries(bytes) {
  const lock = JSON.parse(bytes.toString("utf8"));
  const packages = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  return Object.keys(packages).filter((k) => k !== "" && (!isObject(packages[k]) || blank(packages[k].integrity)));
}

function dependencyProblem(pkg, entry, path) {
  if (!path) return "a dependency names no lockfile";
  const file = pkg.files.find((f) => f.path === path);
  if (!file) return "the lockfile is not a shipped file";
  const named = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase().replace(/^sha256:/, "") : null;
  if (!named) return "the runtime requirements name no sha256 for the lockfile";
  if (named !== file.sha256) return "the lockfile's digest differs from the sha256 the runtime requirements name";
  if (!isNpmLockfile(path)) return null;
  let unpinned;
  try { unpinned = unpinnedEntries(file.bytes); } catch { return "the npm lockfile is not JSON"; }
  if (!unpinned.length) return null;
  return `${unpinned.length} ${unpinned.length === 1 ? "entry" : "entries"} under packages carry no integrity, first ${unpinned[0]}`;
}

function dependencyUnpinned(pkg) {
  const out = [];
  for (const entry of Array.isArray(pkg.requirements.dependencies) ? pkg.requirements.dependencies : []) {
    const path = isObject(entry) ? lockfilePath(entry) : null;
    const why = dependencyProblem(pkg, isObject(entry) ? entry : {}, path);
    if (why) out.push(refuse("dependency-unpinned", why, path ? { file: path } : {}));
  }
  return out;
}

/** Every refusal that applies to a readable package, for the owner given. Empty when none. */
export function findRefusals(pkg, owner) {
  return [
    ...systemsMismatch(pkg),
    ...noReason(pkg),
    ...undeclaredReach(pkg),
    ...spendLimitRefusals(owner),
    ...ceilingMissing(pkg),
    ...ceilingUnset(pkg, owner),
    ...credentialInFiles(pkg),
    ...dependencyUnpinned(pkg),
  ];
}

/** The matched text of every credential in the package, so that no answer repeats it. */
export function credentialTexts(pkg) {
  return pkg.files.flatMap((f) => secretsIn(f.bytes).flatMap((s) => s.texts));
}

// What was accepted knowingly

const leaves = (pkg, name) => descriptorSystems(pkg).some((s) => s.name === name && s.leaves === true)
  || requiredSystems(pkg).some((s) => s.name === name && s.leaves === true);

/** The reach a passed package keeps, each a thing a person should know they accepted. */
export function acceptedKnowingly(pkg) {
  const out = [];
  for (const s of descriptorSystems(pkg)) {
    if (s.access !== "read") {
      out.push({ what: `${s.name} is reached with access ${s.access ?? "unstated"}, not read`, system: s.name,
        why: "the declaration asks for it, and the agent can change what it holds" });
    }
    if (leaves(pkg, s.name)) {
      out.push({ what: `content leaves for ${s.name}`, system: s.name,
        why: "the declaration says so, and what is sent there is out of the owner's hands" });
    }
  }
  for (const c of ceilings(pkg).filter((x) => x.enforced_by === "runtime")) {
    out.push({ what: `the ceiling on ${c.system} per ${c.per} is enforced by the runtime, not the platform`, system: c.system,
      why: "the agent's own runtime keeps count, so a fault there could spend past it" });
  }
  for (const p of programs(pkg).filter((x) => x.reach.spawns.length)) {
    out.push({ what: "the program starts other processes", file: p.path,
      why: "what a started process reaches is not read by this review" });
  }
  const bound = boundNames(pkg);
  for (const p of programs(pkg)) {
    const unbound = [...new Set(p.reach.env.map((e) => e.name))].filter((n) => !bound.has(n) && !isCredentialName(n));
    for (const name of unbound) {
      out.push({ what: `the program reads the environment variable ${name}, which no system binds`, file: p.path,
        why: "the name is not credential-like, and its value is whatever the host's environment holds" });
    }
  }
  return out;
}

// What was not checked

const ALWAYS_NOT_CHECKED = [
  "known vulnerabilities in dependencies",
  "destinations computed at runtime, such as a URL or variable name built from a value",
  "whether each reason is sufficient; a person decides that",
  "behavior when running; the programs were read, not run",
  "files under test, tests, node_modules and .git directories, and files named *.test.*, which were not read",
];
const OTHER_LANGUAGES = new Set([".sh", ".rb", ".go", ".rs", ".java", ".php"]);
const extensionOf = (path) => {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

/** A shipped file that looks like a program this review does not read: one of the named
 *  extensions, or a script with no extension the review knows that begins with `#!`. */
const unreadProgram = (f) => OTHER_LANGUAGES.has(extensionOf(f.path))
  || (!languageOf(f.path) && f.bytes.subarray(0, 2).toString("latin1") === "#!");

/** What this review did not check, always in the same order. */
export function notChecked(pkg) {
  const unread = pkg.files.filter(unreadProgram).map((f) => `${f.path}, a program in a language this review does not read`);
  const lockfiles = (Array.isArray(pkg.requirements.dependencies) ? pkg.requirements.dependencies : [])
    .filter(isObject).map(lockfilePath)
    .filter((p) => p && !isNpmLockfile(p) && pkg.files.some((f) => f.path === p))
    .map((p) => `${p}, a lockfile in a format other than npm, whose entries were not read`);
  return [...ALWAYS_NOT_CHECKED, ...unread, ...[...new Set(lockfiles)]];
}
