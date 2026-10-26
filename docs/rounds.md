# Rounds

The Code stage's record. One entry per round: what was run, what failed, what changed, and
anything the statement did not settle. Conflicts between a test and the statement go here,
unresolved, for the spec owner.

| Round | Ran | Failing before | Changed | Failing after | Notes |
|---|---|---|---|---|---|
| 1 | `npm run verify`; the CI conformance command, with `--permission` | 58 of 58 tests; 4 of 4 conformance cases; self-review | The six stand-ins replaced: `read-package.mjs` (106 lines), `reach.mjs` (263), `secrets.mjs` (40), `rules.mjs` (262), `statement.mjs` (52), `review.mjs` (75) | None. 58 of 58 pass; 4 of 4 cases; removing each program fails 41 to 46 tests; self-review passes | Built first in a scratch copy as a test oracle. No conflict between a test and the statement |
| 2 | 36 seeded property tests, kept outside the repo, against round 1; then `npm run verify` | 11 of 36 properties. 6 are defects the 58 tests do not catch: a host with `_` (`https://redis_cache:6379/`) not refused (SR-08); a credential in a declaration field echoed in the answer, as an AWS secret, a PEM key body, a key lowercased in a URL host, or a key decoded from a `\u` escape (SR-13); a comment's URL refused after a regular expression that follows `if (…)` or `}` (SR-08); `spends.limit` dropping the owner's extra members (SR-16) | `reach.mjs`: `_` allowed in hosts; a `)` closing an `if`, `while`, `for` or `with` condition, and a `}`, start a statement. `review.mjs`: each credential text withheld in any case, anything shaped like a credential withheld, a PEM block withheld whole. `rules.mjs`: `limitOf` echoes the owner's limit as given | None of the 58 tests. 5 of 36 properties, each a probe of a point below the statement leaves open (U2, U8, U14), plus a BOM, which SR-02 settles as not JSON | Suite gap for the spec owner: all 58 tests pass with or without these fixes |
| 3 | A mutation campaign on round 1, kept outside the repo (1,578 mutants), and its verifier's probes; then `npm run verify`, the 36 properties and the campaign's 51 kill inputs | 4 defects the 58 tests do not catch: a URL right after a string escape (`"see:\nhttps://evil.example"`) not refused (SR-08); a host `new URL()` accepts but round 2's filter rejected (`https://a!b.example/`) not refused (SR-08); `process\n  .env.X` and `process/**/.env.X` not found (SR-09); a Python import after `:` or `;` (`if x: import subprocess`) not recorded (SR-17) | `reach.mjs`: no word boundary required before the scheme; the host is whatever the URL parser gives; space allowed around each `.` of an environment read; a Python import may follow `:` or `;` | None of the 58 tests; 51 of 51 kill inputs; properties unchanged at 5 of 36 | The suite killed 64% of the campaign's mutants (987 killed, 28 timed out). Of the 563 that survived, 374 were judged suite gaps, chiefly in comment blanking (`reach.mjs`, 57%) and credential patterns (`secrets.mjs`, 41%): for the spec owner |
| 4 | A probe from the statement review: a `//` comment, then U+2028 or a lone `\r`, then a `fetch`, run under Node; then `npm run verify`, the 36 properties and the 51 kill inputs | 1 defect the 58 tests do not catch: code after U+2028, U+2029 or a lone `\r` on a comment line runs, and its URL was not refused (SR-08). Python's lone `\r` likewise | `reach.mjs`: a JavaScript line comment ends at any line terminator; a Python comment ends at `\n` or `\r` | None of the 58 tests; 51 of 51 kill inputs; properties unchanged at 5 of 36 | Line numbers still count `\n` only, as the suite's helper does (U9) |

## Conflicts

None. Every test passes with the statement read as written.

## Points the statement does not settle

Each choice below is the program's, not the statement's. The spec owner may settle any of them.

| # | Point | Choice made | Settled by a test |
|---|---|---|---|
| U1 | Order of refusals, `reaches` and `accepted_knowingly`; SR-20 needs one | Refusals in SR order (SR-06 to SR-14); within a rule, files in byte order, then line order, with credential kinds in the publisher's order. `reaches` and `accepted_knowingly` follow the descriptor; `spends.ceilings` follows the runtime requirements | No |
| U2 | SR-05 edges: a declaration that parses but is not an object; a broken current name beside a readable former name | `unreadable` in both | No |
| U3 | Other refusals beside `unreadable` | Only the owner's spending limit is still checked; checks that need the declarations are skipped | Partly |
| U4 | `plugin.json` that is invalid or lacks a member | Treated as absent per member: name falls back to the directory's name, version to `agent_version` | No |
| U5 | Symbolic links | A link to a file is followed and shipped; a link to a folder is not followed; a dangling link makes the package unreadable | No |
| U6 | `spend_limit` edges | `most_micro` must be a safe integer (2^53 and above refused); `-0` accepted; extra members accepted and echoed | Partly |
| U7 | Several owner ceilings for one system and period | The first with a valid number | No |
| U8 | URL forms SR-08 does not define | Host as `new URL()` gives it: lowercase, punycode, no trailing dot; every host it accepts is refused. A computed host (`${…}`, f-string, concatenation) is not refused; `not_checked` names destinations computed at runtime. Text `new URL()` rejects (port above 65535, numeric last label) is not a URL. A soft hyphen in a host cuts its name short; the URL is still refused | Partly |
| U9 | What counts as code, and what a line is | Python docstrings and triple-quoted strings are code. JavaScript regular expression literals are code, but a URL written with escaped slashes inside one is not a literal URL. A comment ends at any line terminator of its language; `line` counts `\n` only | Partly |
| U10 | Environment reads beyond SR-09's list | Also `process.env?.X`, space or a comment around each `.`, backtick keys, and quoted destructuring keys with defaults. Aliases (`const e = process.env`) are not recognized. A string containing `process.env.X` counts as a read | No |
| U11 | How many `accepted_knowingly` entries | One per system, per runtime ceiling, per program that starts processes, and per program and variable pair | Partly |
| U12 | SR-14 details | Lockfile path relative to the package root. An entry with no lockfile or no `sha256` is refused. A `sha256:` prefix and uppercase hex are accepted. npm format means a file named `package-lock.json` or `npm-shrinkwrap.json`; a lockfile version 1 has no `packages` and passes the integrity check | Partly |
| U13 | SR-13 granularity and binary files | One refusal per file and kind, at its first line. Every shipped file is scanned, binaries included, which is stricter than the publisher | Partly |
| U14 | Case-insensitive credential names beyond ASCII | `toUpperCase`, so `V2_ſECRET` is credential-like. This fails closed | No |
| U15 | An internal error | Refused with rule `unreadable`, carrying `package` when it was read | No |
| U16 | `not_checked` beyond the five fixed lines | Also each shipped `.sh`, `.rb`, `.go`, `.rs`, `.java` or `.php` file, each file with no known extension that starts with `#!`, and each lockfile not in npm format | Partly |
