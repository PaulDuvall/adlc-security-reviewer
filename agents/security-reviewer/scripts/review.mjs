// The security reviewer. One security-review-request-v1 on standard input, one JSON answer
// on standard output: passed with a statement, refused with every refusal found, or
// declined (docs/spec.md, Interface). It reads the package and writes nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPackage } from "./read-package.mjs";
import { credentialTexts, findRefusals, spendLimitRefusals } from "./rules.mjs";
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

/** Every string in the answer with each credential text replaced, so none is repeated. */
function withheld(value, texts) {
  if (!texts.length) return value;
  if (typeof value === "string") return texts.reduce((s, t) => s.split(t).join("[withheld]"), value);
  if (Array.isArray(value)) return value.map((v) => withheld(v, texts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withheld(v, texts)]));
  }
  return value;
}

function reviewPackage(pkg, owner) {
  const refusals = findRefusals(pkg, owner);
  const reply = refusals.length ? refused(refusals, pkg) : { result: "passed", statement: statementOf(pkg, owner) };
  const texts = [...new Set(credentialTexts(pkg))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return withheld(reply, texts);
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
    return refused([{ rule: "unreadable", why: "the reviewer could not finish reading the package's declarations" }], pkg);
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
