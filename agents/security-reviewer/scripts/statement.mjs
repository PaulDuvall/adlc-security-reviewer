// Write the security statement for a package that passed (SR-16 to SR-18).
import { acceptedKnowingly, leavesFor, limitOf, notChecked, ownerNumber } from "./rules.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const named = (systems) => list(systems).filter((s) => typeof s.name === "string");

/** The package as every answer about a readable one names it. */
export const packageOf = (pkg) => ({ name: pkg.name, version: pkg.version, digest: pkg.digest });

/** One entry per declared system, in the descriptor's order. `leaves` appears only where the
 *  descriptor or the runtime requirements state it: absent means not stated (SR-16). */
function reachesOf(pkg) {
  const required = named(pkg.requirements.systems);
  return named(pkg.descriptor.systems).map((s) => {
    const r = required.find((x) => x.name === s.name) ?? {};
    const entry = {
      system: s.name,
      access: s.access ?? null,
      why: s.needs,
      kind: r.kind ?? null,
      credential: r.credential ?? null,
    };
    const leaves = leavesFor(pkg, s.name);
    if (leaves !== undefined) entry.leaves = leaves;
    return entry;
  });
}

function ceilingsOf(pkg, owner) {
  return list(pkg.requirements.ceilings).map((c) => ({
    system: c.system, per: c.per, most: ownerNumber(owner, c), enforced_by: c.enforced_by,
  }));
}

/** The descriptor's refusals, one per line, and the one every statement carries. */
function neverOf(pkg) {
  const r = pkg.descriptor.refusals;
  const lines = Array.isArray(r) ? r.filter((x) => typeof x === "string") : typeof r === "string" ? r.split(/\r?\n/) : [];
  return [...lines.map((l) => l.trim()).filter(Boolean), "reach any destination outside the systems in reaches"];
}

/** The statement for a package no refusal rule applies to. */
export function statementOf(pkg, owner) {
  return {
    format: "security-statement-v1",
    package: packageOf(pkg),
    reaches: reachesOf(pkg),
    spends: { limit: limitOf(owner), ceilings: ceilingsOf(pkg, owner) },
    never: neverOf(pkg),
    accepted_knowingly: acceptedKnowingly(pkg),
    not_checked: notChecked(pkg),
    decided_by: "rule",
  };
}
