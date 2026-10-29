// The security reviewer. One security-review-request-v1 on standard input, one JSON answer
// on standard output: passed with a statement, refused with every refusal found, or
// declined (docs/spec.md, Interface). It reads the package and writes nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPackage } from "./read-package.mjs";
import { credentialTexts, findRefusals, spendLimitRefusals } from "./rules.mjs";
import { SECRETS } from "./secrets.mjs";
import { packageOf, statementOf } from "./statement.mjs";

const DECLINED = "This reviewer only reviews: it grants, binds, installs and changes nothing. Ask for a review instead.";

const refused = (refusals, pkg) => (pkg
  ? { result: "refused", package: packageOf(pkg), refusals }
  : { result: "refused", refusals });
const badRequest = (why) => refused([{ rule: "bad-request", why }]);

/** The request as an object, or the reason it is not one this reviewer reads. */
function parse(request) {
  let r = request;
  if (typeof r === "string" || Buffer.isBuffer(r)) {
    // A request too long to decode is not one that is not JSON: the reviewer cannot finish (SR-01).
    try { r = String(r); } catch { return { unreadable: "the request is too long to read" }; }
    try { r = JSON.parse(r); } catch { return { why: "the request is not JSON" }; }
  }
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { why: "the request is not a JSON object" };
  if (r.review !== "v1") return { why: 'the request does not carry "review": "v1"' };
  return { request: r };
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
// A private key's pattern matches only its first line, but its body is the key, so a PEM
// block is withheld whole: from that line to its END line, or to the end of the text.
const PEM_BLOCK = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]*?(?:-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}|$)/g;
const SHAPES = SECRETS.map((s) => new RegExp(s.find.source, `${s.find.flags}g`));

const TEXTS_PER_PATTERN = 1000;

/** The package's credential texts as patterns, in any case, a thousand texts to a pattern and
 *  the longest first. One pattern per text made the work texts times strings: 10,000 texts
 *  took 18 s to withhold. */
function textPatterns(texts) {
  const unique = [...new Set(texts)].filter(Boolean).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (let i = 0; i < unique.length; i += TEXTS_PER_PATTERN) {
    out.push(new RegExp(unique.slice(i, i + TEXTS_PER_PATTERN).map((t) => t.replace(SPECIAL, "\\$&")).join("|"), "gi"));
  }
  return out;
}

/** The span of a pattern's match at every place one starts. Searching again one character on,
 *  not after the match, finds each text that overlaps another. */
function spansFromEveryStart(re, s) {
  const spans = [];
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0]) spans.push([m.index, m.index + m[0].length]);
    re.lastIndex = m.index + 1;
  }
  return spans;
}

/** A string with every match of the patterns and of the credential texts withheld. All
 *  matches are found in the string as given and merged where they overlap or touch, so
 *  withholding one leaves no fragment of another (SR-13). */
function withholdText(s, patterns, texts) {
  const spans = [
    ...patterns.flatMap((re) => [...s.matchAll(re)].filter((m) => m[0]).map((m) => [m.index, m.index + m[0].length])),
    ...texts.flatMap((re) => spansFromEveryStart(re, s)),
  ];
  if (!spans.length) return s;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let at = 0;
  for (const [start, end] of merged) {
    out += `${s.slice(at, start)}[withheld]`;
    at = end;
  }
  return out + s.slice(at);
}

/** Every string in the answer with each credential text found in the package replaced, in
 *  any case (a URL's host is lowercased), and with anything else shaped like a credential
 *  replaced too, since a declaration's decoded text can differ from its bytes (SR-13). */
function withheld(value, texts) {
  const patterns = [PEM_BLOCK, ...SHAPES];
  const textRes = textPatterns(texts);
  const scrub = (v) => {
    if (typeof v === "string") return withholdText(v, patterns, textRes);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(value);
}

function reviewPackage(pkg, owner) {
  const refusals = findRefusals(pkg, owner);
  const reply = refusals.length ? refused(refusals, pkg) : { result: "passed", statement: statementOf(pkg, owner) };
  return withheld(reply, credentialTexts(pkg));
}

/** The answer to one request, a JSON string or an already parsed object. `options.cwd` is
 *  the directory a relative package path is resolved against. */
export function answer(request, options = {}) {
  const { request: r, why, unreadable } = parse(request);
  if (unreadable) return refused([{ rule: "unreadable", why: unreadable }]);
  if (!r) return badRequest(why);
  if (r.ask !== "review") return { result: "declined", why: DECLINED };
  if (typeof r.package !== "string" || !r.package.trim()) return badRequest("the request names no package directory");

  let pkg;
  try { pkg = readPackage(resolve(options.cwd ?? process.cwd(), r.package)); } catch (e) {
    if (e.code !== "unreadable") throw e;
    return refused([{ rule: "unreadable", why: e.message }, ...spendLimitRefusals(r.owner)]);
  }
  // An error the review raised as unreadable carries a fixed reason; any other is not named,
  // since it may come from a program or from a declaration.
  try { return reviewPackage(pkg, r.owner); } catch (e) {
    if (e?.code !== "unreadable") report(e);
    const why = e?.code === "unreadable" ? e.message : "the reviewer could not finish reading the package";
    return withheldAfterFault(refused([{ rule: "unreadable", why }], pkg), pkg);
  }
}

/** An answer after the review stopped. The package's credential texts are still withheld from
 *  it, in any case (SR-13); where they cannot be found either, the package's name and version
 *  are withheld whole, since either may repeat one. */
function withheldAfterFault(reply, pkg) {
  let texts;
  try { texts = credentialTexts(pkg); } catch {
    return withheld({ ...reply, package: { ...reply.package, name: "[withheld]", version: "[withheld]" } }, []);
  }
  return withheld(reply, texts);
}

/** Writes an unexpected error's kind and stack frames to standard error, for whoever runs the
 *  reviewer. Its message is left out, since it may quote the package and no output may repeat
 *  a credential (SR-13). Standard output still carries the one answer (SR-01). */
function report(e) {
  const kind = typeof e?.name === "string" && /^\w+$/.test(e.name) ? e.name : "error";
  const frames = String(e?.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
  process.stderr.write(`security-reviewer: internal ${kind}\n${frames.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reply;
  // Standard input is read as bytes: a read that fails is one the reviewer cannot finish (SR-01),
  // not an empty request.
  try { reply = answer(readFileSync(0)); } catch (e) {
    report(e);
    reply = refused([{ rule: "unreadable", why: "the reviewer could not finish its answer" }]);
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
