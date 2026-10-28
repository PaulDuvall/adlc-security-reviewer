// Check the declaration and the owner's limits against what the package holds (SR-06 to
// SR-14, SR-22, SR-23), and say what was accepted knowingly (SR-17) and what was not
// checked (SR-18).
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findReach, isCredentialName, languageOf } from "./reach.mjs";
import { ships } from "./read-package.mjs";
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
      if (language) found.push({ path: f.path, reach: findReach(f.bytes.toString("utf8"), language, f.path) });
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
      // A name this review cannot decode may be credential-like, so it counts as one.
      ...p.reach.env.filter((e) => !bound.has(e.name) && (e.undecodable || isCredentialName(e.name))).map((e) => ({ line: e.line, r: refuse("undeclared-reach",
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
  // The scripts reach a credential-bearing system themselves, so the platform never sees
  // what they spend there (Common Agent Specification §12.4 item 4).
  const credentialed = new Set(requiredSystems(pkg).filter((s) => !blank(s.credential)).map((s) => s.name));
  return [
    ...spending.filter((s) => !capped.has(s.name)).map((s) => refuse("ceiling-missing",
      `${s.name} spends, and the runtime requirements set no ceiling on it`, { system: s.name })),
    ...ceilings(pkg).filter((c) => !ENFORCERS.has(c.enforced_by)).map((c) => refuse("ceiling-missing",
      `the ceiling on ${c.system} per ${c.per} does not say whether the runtime or the platform enforces it`, { system: c.system })),
    ...ceilings(pkg).filter((c) => c.enforced_by === "platform" && credentialed.has(c.system)).map((c) => refuse("ceiling-missing",
      `the ceiling on ${c.system} per ${c.per} says the platform enforces it, but the scripts reach ${c.system} with a credential, so only the runtime can count it`,
      { system: c.system })),
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

// What a program loads (SR-22)

// Node tries a name as written, then with each ending, then as a folder: its package.json
// `main`, then its index. The ES module and TypeScript endings cover a bundler's reading too.
const ENDINGS = ["", ".js", ".json", ".node", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const INDEXES = ENDINGS.slice(1).map((e) => `index${e}`);
const RELATIVE = /^\.\.?(?:[/\\]|$)/;
// A built-in module, or a URL that SR-08 refuses already.
const NOT_FILES = /^(?:node|https?|wss?):/i;
// A scheme (file:, data:, a drive such as C:) or an absolute path: never a file the package ships.
const ABSOLUTE = /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|[/\\])/;
const UNREAD_MODULES = new Set(["test", "tests"]);

const shippedPaths = new WeakMap();
const shippedSet = (pkg) => {
  if (!shippedPaths.has(pkg)) shippedPaths.set(pkg, new Set(pkg.files.map((f) => f.path)));
  return shippedPaths.get(pkg);
};
const under = (dir, name) => (dir ? `${dir}/${name}` : name);
const leavesPackage = (path) => path === ".." || path.startsWith("../");
// Node resolves an absolute `main` from the filesystem's root, outside the package.
const packagePath = (dir, target) => (posix.isAbsolute(target) ? ".."
  : posix.normalize(posix.join(dir || ".", target)).replace(/\/+$/, "").replace(/^\.$/, ""));

/** The shipped package.json in a package folder, parsed, or null when there is none. One that
 *  is not a JSON object is read as empty: Node stops at it, and it maps nothing. */
function manifest(pkg, dir) {
  const file = pkg.files.find((f) => f.path === under(dir, "package.json"));
  if (!file) return null;
  try {
    const value = JSON.parse(file.bytes.toString("utf8"));
    return isObject(value) ? value : {};
  } catch { return {}; }
}

/** The nearest shipped package.json at or above a program's folder, with its folder. */
function nearestManifest(pkg, program) {
  for (let dir = posix.dirname(program); ; dir = posix.dirname(dir)) {
    const folder = dir === "." ? "" : dir;
    const found = manifest(pkg, folder);
    if (found) return { dir: folder, manifest: found };
    if (!folder) return null;
  }
}

/** Whether the file Node loads for a package path is one this review read. It tries each
 *  candidate in turn: the first that ships passes; one outside the package, or one that would
 *  not ship, fails; and finding none fails too, since an absent name may be a file under a
 *  folder link, or in another letter case, neither of which the review reads. */
function loadsShipped(pkg, path, folderOnly) {
  if (leavesPackage(path)) return false;
  const asFile = (p) => ENDINGS.map((e) => p + e);
  const main = manifest(pkg, path)?.main;
  const target = typeof main === "string" && main.trim() ? packagePath(path, main) : null;
  const candidates = [
    ...(folderOnly || !path ? [] : asFile(path)),
    ...(target === null ? [] : [...asFile(target), ...INDEXES.map((i) => under(target, i))]),
    ...INDEXES.map((i) => under(path, i)),
  ];
  const shipped = shippedSet(pkg);
  for (const c of candidates) {
    if (leavesPackage(c)) return false;
    if (shipped.has(c)) return true;
    if (!ships(c)) return false;
  }
  return false;
}

/** The strings a package.json `imports` or `exports` map gives for a key, through any
 *  conditions and `*` patterns. Null when it has no entry for the key. */
function mapTargets(map, key) {
  const strings = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
    : isObject(v) ? Object.values(v).flatMap(strings) : []);
  if (!isObject(map)) return null;
  if (Object.hasOwn(map, key)) return strings(map[key]);
  const found = [];
  for (const k of Object.keys(map)) {
    const [before, after, more] = k.split("*");
    // A `*` matches one character or more, as Node matches it.
    if (after === undefined || more !== undefined || key.length < k.length || !key.startsWith(before) || !key.endsWith(after)) continue;
    const part = key.slice(before.length, key.length - after.length);
    found.push(...strings(map[k]).map((t) => t.replaceAll("*", part)));
  }
  return found.length ? found : null;
}

/** Whether every file a package.json maps a key to is one this review read. A target that is
 *  not `./…` names a package, or is one Node refuses to load. */
const targetsShipped = (pkg, dir, targets) => targets.filter((t) => t.startsWith("./"))
  .every((t) => loadsShipped(pkg, packagePath(dir, t), t.endsWith("/")));

/** The package path a relative specifier names, and whether it names a folder. Null when Node
 *  could not turn it into a path, so that it loads nothing. */
function relativeTarget(pkg, program, value, esm) {
  const from = resolve(pkg.dir, program);
  let abs;
  let written = value.replaceAll("\\", "/");
  if (esm) {
    // An ES module specifier is a URL: escapes decoded, `?` and `#` dropped, `%2e%2e` a step up.
    try {
      const url = new URL(value, pathToFileURL(from));
      // Node rejects an encoded `/` or `\` outright, so such an import loads nothing.
      if (/%2f|%5c/i.test(url.pathname)) return null;
      abs = fileURLToPath(url);
      written = url.pathname;
    } catch { return null; }
  } else abs = resolve(dirname(from), written);
  const rel = relative(pkg.dir, abs).split(sep).join("/");
  if (isAbsolute(rel)) return { path: "..", folderOnly: true };
  return { path: rel, folderOnly: !rel || /(?:^|\/)\.{0,2}$/.test(written) };
}

/** The host a URL names, as SR-08 reports it, or null when it does not parse. */
function hostOfUrl(value) {
  try { return new URL(value).hostname.replace(/\.+$/, "") || null; } catch { return null; }
}

/** Whether a JavaScript import loads code this review does not read. `urls` are the URLs
 *  SR-08 found in the same program. */
function jsLoadsUnread(pkg, program, { value, esm, line, undecodable }, urls) {
  // A specifier this review cannot decode might name any module (SR-22).
  if (undecodable) return true;
  if (RELATIVE.test(value)) {
    const target = relativeTarget(pkg, program, value, esm);
    return target !== null && !loadsShipped(pkg, target.path, target.folderOnly);
  }
  if (/^node:/i.test(value)) return false;
  if (NOT_FILES.test(value)) {
    // A URL is refused here unless SR-08 refuses it already. One that does not parse, such as
    // `https:`, is a package name to Node, which may load anything, so it is refused too.
    const host = hostOfUrl(value);
    return host === null || !urls.some((u) => u.line === line && u.host === host);
  }
  if (ABSOLUTE.test(value)) return true;
  const scope = nearestManifest(pkg, program);
  if (value.startsWith("#")) {
    // A subpath import maps through the nearest package.json; with none here, Node looks
    // above the package, which the review does not read.
    if (!scope) return true;
    const targets = mapTargets(scope.manifest.imports, value);
    return targets !== null && !targetsShipped(pkg, scope.dir, targets);
  }
  // A package that names itself loads its own files through its `exports`.
  const name = scope?.manifest.name;
  if (typeof name !== "string" || scope.manifest.exports === undefined || (value !== name && !value.startsWith(`${name}/`))) return false;
  const exports = scope.manifest.exports;
  const keys = isObject(exports) ? Object.keys(exports) : [];
  const subpaths = keys.filter((k) => k.startsWith("."));
  // Node refuses an exports object that mixes subpaths with conditions, so nothing loads.
  if (subpaths.length && subpaths.length !== keys.length) return false;
  const map = subpaths.length ? exports : { ".": exports };
  const targets = mapTargets(map, value === name ? "." : `.${value.slice(name.length)}`);
  return targets !== null && !targetsShipped(pkg, scope.dir, targets);
}

const parts = (module) => module.normalize("NFKC").replace(/^\.+/, "").split(".");
const unreadModule = (module) => parts(module).some((p) => UNREAD_MODULES.has(p));

/** The Python module a test or tests part makes unread: the module path, or the module path
 *  with a name its `from` imports, since that name may be a submodule. A literal this review
 *  cannot decode is unread too. Null when none. */
function pythonUnread({ specifier, names, undecodable }) {
  if (undecodable || unreadModule(specifier)) return specifier;
  const name = names.find(unreadModule);
  return name === undefined ? null : `${specifier}${specifier.endsWith(".") ? "" : "."}${name}`;
}

// The codecs Python reads as UTF-8, or as ASCII, which UTF-8 reads the same: the codecs' own
// module names, and their encodings.aliases.
const READ_CODEC_MODULES = new Set(["utf_8", "utf_8_sig", "ascii"]);
const READ_CODEC_ALIASES = new Set([
  "cp65001", "u8", "utf", "utf8", "utf8_ucs2", "utf8_ucs4",
  "646", "ansi_x3.4_1968", "ansi_x3.4_1986", "ansi_x3_4_1968", "cp367", "csascii", "ibm367",
  "iso646_us", "iso_646.irv_1991", "iso_ir_6", "us", "us_ascii",
]);

/** Whether Python reads a source declared in this encoding as UTF-8 or ASCII. Its tokenizer
 *  takes any name whose first 12 characters read `utf-8` or `utf-8-…` as UTF-8; any other
 *  name goes to its codec lookup, which collapses everything but letters, digits and `.`, and
 *  tries an alias also with each `.` as `_`, but a module only by the name as collapsed. */
function readCoding(name) {
  const short = name.slice(0, 12).toLowerCase().replace(/_/g, "-");
  if (short === "utf-8" || short.startsWith("utf-8-")) return true;
  const codec = name.toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");
  return READ_CODEC_MODULES.has(codec) || READ_CODEC_ALIASES.has(codec) || READ_CODEC_ALIASES.has(codec.replace(/\./g, "_"));
}

function unreadCode(pkg) {
  const out = [];
  for (const p of programs(pkg)) {
    const python = languageOf(p.path) === "python";
    const coding = p.reach.coding;
    if (coding && !readCoding(coding.name)) {
      // The review reads every program as UTF-8, so one decoded otherwise is not read.
      out.push(refuse("unread-code", `the program declares the source encoding ${coding.name}, which this review does not read`,
        { system: `coding: ${coding.name}`, file: p.path, line: coding.line }));
    }
    for (const i of p.reach.imports) {
      const system = python ? pythonUnread(i) : jsLoadsUnread(pkg, p.path, i, p.reach.urls) ? i.specifier : null;
      if (system !== null) {
        out.push(refuse("unread-code", `the program loads ${system}, which this review does not read`,
          { system, file: p.path, line: i.line }));
      }
    }
  }
  return out;
}

// Where a host finds a package's MCP servers: an mcp.json (Agent Plugins) or .mcp.json (Claude
// Code) at the root, whose mcpServers must be a map, and a plugin.json whose mcpServers, when
// present, must be one too, since a path or a bundle there is not read.
const MCP_FILES = ["mcp.json", ".mcp.json"];
const PLUGIN_FILES = ["plugin.json", ".claude-plugin/plugin.json"];

function mcpServers(pkg) {
  const declared = new Set(descriptorSystems(pkg).map((s) => s.name));
  const out = [];
  for (const path of [...MCP_FILES, ...PLUGIN_FILES]) {
    const file = pkg.files.find((f) => f.path === path);
    if (!file) continue;
    let config;
    try { config = JSON.parse(file.bytes.toString("utf8")); } catch { config = undefined; }
    const plugin = PLUGIN_FILES.includes(path);
    // A plugin.json that is not JSON is read as absent (U4), and may leave mcpServers out.
    if (plugin && (!isObject(config) || config.mcpServers === undefined)) continue;
    if (!isObject(config) || !isObject(config.mcpServers)) {
      out.push(refuse("unreadable", `${path} is not a JSON object whose mcpServers is a map of servers by name`, { file: path }));
      continue;
    }
    out.push(...Object.keys(config.mcpServers).filter((name) => !declared.has(name)).map((name) => refuse("undeclared-reach",
      `${path} names the MCP server ${name}, which the descriptor does not declare`, { system: name, file: path })));
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
    ...unreadCode(pkg),
    ...mcpServers(pkg),
  ];
}

/** The matched text of every credential in the package, so that no answer repeats it. */
export function credentialTexts(pkg) {
  return pkg.files.flatMap((f) => secretsIn(f.bytes).flatMap((s) => s.texts));
}

// What was accepted knowingly

/** Whether content leaves for a system, as the descriptor and the runtime requirements state
 *  it: undefined where neither does (SR-16). Any stated value but false counts as leaving. */
export function leavesFor(pkg, name) {
  const stated = [...descriptorSystems(pkg), ...requiredSystems(pkg)]
    .filter((s) => s.name === name && s.leaves !== undefined && s.leaves !== null).map((s) => s.leaves);
  return stated.length ? stated.some((v) => v !== false) : undefined;
}

/** The reach a passed package keeps, each a thing a person should know they accepted. */
export function acceptedKnowingly(pkg) {
  const out = [];
  for (const s of descriptorSystems(pkg)) {
    if (s.access !== "read") {
      out.push({ what: `${s.name} is reached with access ${s.access ?? "unstated"}, not read`, system: s.name,
        why: "the declaration asks for it, and the agent can change what it holds" });
    }
    if (leavesFor(pkg, s.name)) {
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
    const unbound = [...new Set(p.reach.env.filter((e) => !e.undecodable).map((e) => e.name))].filter((n) => !bound.has(n) && !isCredentialName(n));
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
  "destinations and module paths computed at runtime, such as a URL, variable name or module path built from a value",
  "whether each reason is sufficient; a person decides that",
  "behavior when running; the programs were read, not run",
  "files under test, tests, node_modules and .git directories, and files named *.test.*, which were not read",
  "offering authority, external inputs and workspaces, which were not read",
];
const OTHER_LANGUAGES = new Set([".sh", ".rb", ".go", ".rs", ".java", ".php"]);
const extensionOf = (path) => {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
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
