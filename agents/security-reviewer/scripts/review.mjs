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
    try { r = JSON.parse(String(r)); } catch { return { why: "the request is not JSON" }; }
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

/** A string with every match of the patterns withheld. All matches are found in the string as
 *  given and merged where they overlap or touch, so withholding one leaves no fragment of
 *  another (SR-13). */
function withholdText(s, patterns) {
  const spans = patterns.flatMap((re) => [...s.matchAll(re)].filter((m) => m[0]).map((m) => [m.index, m.index + m[0].length]));
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
  const patterns = [PEM_BLOCK, ...[...new Set(texts)].map((t) => new RegExp(t.replace(SPECIAL, "\\$&"), "gi")), ...SHAPES];
  const scrub = (v) => {
    if (typeof v === "string") return withholdText(v, patterns);
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
  const { request: r, why } = parse(request);
  if (!r) return badRequest(why);
  if (r.ask !== "review") return { result: "declined", why: DECLINED };
  if (typeof r.package !== "string" || !r.package.trim()) return badRequest("the request names no package directory");

  let pkg;
  try { pkg = readPackage(resolve(options.cwd ?? process.cwd(), r.package)); } catch (e) {
    if (e.code !== "unreadable") throw e;
    return refused([{ rule: "unreadable", why: e.message }, ...spendLimitRefusals(r.owner)]);
  }
  try { return reviewPackage(pkg, r.owner); } catch {
    return withheld(refused([{ rule: "unreadable", why: "the reviewer could not finish reading the package's declarations" }], pkg), []);
  }
}

function readStandardInput() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reply;
  try { reply = answer(readStandardInput()); } catch {
    reply = refused([{ rule: "unreadable", why: "the package could not be read" }]);
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
