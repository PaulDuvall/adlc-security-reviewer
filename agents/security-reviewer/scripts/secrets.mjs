// Credential patterns, copied with changes from the publisher's list: CommonAgent/adlc
// agents/publisher/scripts/inspect.mjs at fa174cf, Copyright 2026 Jeff Schneider, Apache-2.0
// (see NOTICE and LICENSES/Apache-2.0.txt). Changed here: each entry names its kind,
// carriesASecret is rewritten and secretsIn is added. Every entry is a thing that is only ever
// a live credential. Each pattern is written so that it does not match its own source text,
// since this file is a shipped file of a package this reviewer reviews (SR-21): the keystore
// header is written with `-{5}` for its dashes, so the literal header never appears here.

export const SECRETS = [
  { what: "a private key", find: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { what: "a service-account key", find: /"type"\s*:\s*"service_account"/ },
  { what: "a service-account key", find: /"private_key"\s*:\s*"-----BEGIN/ },
  { what: "an AWS access key", find: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: "an AWS secret key", find: /aws_secret_access_key\s*[=:]\s*\S{20,}/i },
  // A NATS seed is 58 characters: the S, the kind, and 56 of base32.
  { what: "an NKey seed", find: /\bS[UOAN][A-Z2-7]{56}\b/ },
  { what: "a PKCS#12 keystore", find: /-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}/ },
];

const textOf = (bytes) => (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));

/** The kind of the first credential the bytes carry, or null. */
export function carriesASecret(bytes) {
  const text = textOf(bytes);
  return SECRETS.find((s) => s.find.test(text))?.what ?? null;
}

/** Every credential the bytes carry: its kind, its line, and the matched text, which the
 *  caller uses only to make sure no answer repeats it. One entry per kind, at its first line. */
export function secretsIn(bytes) {
  const text = textOf(bytes);
  const found = new Map();
  for (const s of SECRETS) {
    for (const m of text.matchAll(new RegExp(s.find.source, `${s.find.flags}g`))) {
      if (!found.has(s.what)) {
        found.set(s.what, { what: s.what, line: text.slice(0, m.index).split("\n").length, texts: [] });
      }
      found.get(s.what).texts.push(m[0]);
    }
  }
  return [...found.values()];
}
