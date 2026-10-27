# Traceability

Requirement to test to program. Requirements are in [spec.md](spec.md). Tests are in
`agents/security-reviewer/test/`; programs in `agents/security-reviewer/scripts/`. Locked at the
`handoff` tag. `tools/removal-check.mjs` reads the Tests column: once the programs exist, the
suite must pass every test named here, by name, and no other.

| Req | Tests | Program | Conformance harness | Other check |
|---|---|---|---|---|
| SR-01 | SR-01 writes one JSON object on one line, ends with a newline, and exits 0 | review.mjs |  |  |
| SR-02 | SR-02 refuses a request that is not JSON<br>SR-02 refuses a request that does not carry review v1 | review.mjs |  |  |
| SR-03 | SR-03 declines a request to bind the package's credential<br>SR-03 declines every ask other than review | review.mjs | case 4 |  |
| SR-04 | SR-04 leaves every file in the package as it was, whatever the answer | all (runs read-only) |  | CI runs under `--permission` with read-only files |
| SR-05 | SR-05 refuses a package directory that does not exist<br>SR-05 refuses a descriptor or runtime requirements that is not JSON<br>SR-05 reads descriptor.json and install.json when the current names are absent<br>SR-05 reads the current name where a former name is also present<br>SR-05 readPackage reads the descriptor, the runtime requirements and the shipped files<br>SR-05 readPackage throws an error with code unreadable | read-package.mjs, review.mjs |  |  |
| SR-06 | SR-06 refuses when the descriptor and the runtime requirements name different systems | rules.mjs |  |  |
| SR-07 | SR-07 refuses a system with a missing or blank reason, naming it | rules.mjs | case 1 (fails a pass with no reason) |  |
| SR-08 | SR-08 refuses a URL in code, naming the hostname, the file and the line<br>SR-08 does not count a URL inside a comment<br>SR-08 finds a URL in a string followed by a comment, in a template, and in Python<br>SR-08 findReach finds URLs in JavaScript code and not in comments<br>SR-08 findReach finds URLs in Python code and not in comments<br>SR-08 refuses every literal URL a parser accepts, whatever its case or what comes before it<br>SR-08 does not count a comment's URL after a regular expression or a division<br>SR-08 findReach ends comments where each language ends them, and keeps strings and regular expressions whole<br>SR-08 languageOf names JavaScript and Python programs, and nothing else | reach.mjs, rules.mjs | case 2 |  |
| SR-09 | SR-09 refuses an unbound credential-like variable, naming it, the file and the line<br>SR-09 recognizes bracket reads, destructuring and Python reads<br>SR-09 recognizes a read split by space or a comment<br>SR-09 does not count a credential-like variable the runtime requirements bind<br>SR-09 findReach finds every environment read form in JavaScript<br>SR-09 findReach finds every environment read form in Python<br>SR-09 isCredentialName reads the parts of a name | reach.mjs, rules.mjs |  |  |
| SR-10 | SR-10 refuses when the owner set no spending limit<br>SR-10 refuses a malformed spending limit<br>SR-10 accepts a spending limit of zero | rules.mjs | case 3 |  |
| SR-11 | SR-11 refuses a spending system with no ceiling<br>SR-11 refuses a ceiling that does not say which side enforces it<br>SR-11 refuses a platform ceiling on a system the scripts reach with a credential | rules.mjs |  |  |
| SR-12 | SR-12 refuses a ceiling the owner set no number for | rules.mjs |  |  |
| SR-13 | SR-13 refuses a shipped file that carries a private key, without repeating it<br>SR-13 refuses an AWS access key in a program, without repeating it<br>SR-13 does not read files under test folders<br>SR-13 SECRETS carries the publisher's credential patterns<br>SR-13 carriesASecret names the kind of credential, and passes ordinary text<br>SR-13 refuses each kind of credential in the publisher's list, without repeating it<br>SR-13 does not repeat a credential that a declaration field or a URL carries<br>SR-13 carriesASecret names each kind in the publisher's list | secrets.mjs, rules.mjs, review.mjs |  |  |
| SR-14 | SR-14 passes a dependency whose lockfile is shipped, matches its digest and pins every entry<br>SR-14 refuses a dependency whose lockfile is missing, differs from its digest, or leaves an entry unpinned | rules.mjs |  |  |
| SR-15 | SR-15 lists every refusal found in one answer | rules.mjs, review.mjs |  |  |
| SR-16 | SR-16 passes a sound package with a statement of reach, reasons, limit and refusals<br>SR-16 lists every ceiling with the owner's number and the side that enforces it<br>SR-16 states leaves where the package states it, and any value but false as leaving<br>SR-16 states the owner's limit member for member | statement.mjs | case 1 |  |
| SR-17 | SR-17 accepts knowingly an access other than read<br>SR-17 accepts knowingly a system that content leaves for<br>SR-17 accepts knowingly a ceiling only the runtime enforces<br>SR-17 accepts knowingly a program that starts other processes<br>SR-17 accepts knowingly an unbound variable that is not credential-like<br>SR-17 findReach finds process starts | reach.mjs, rules.mjs |  |  |
| SR-18 | SR-18 names what was not checked<br>SR-18 names a program in a language it does not read<br>SR-18 names a lockfile in a format other than npm | rules.mjs |  |  |
| SR-19 | SR-19 binds every answer about a readable package to its digest<br>SR-19 changes the digest with one shipped byte, and not with a test file<br>SR-19 packageDigest follows its definition<br>SR-19 ships excludes test folders, node_modules, .git and test files | read-package.mjs |  |  |
| SR-20 | SR-20 gives a byte-identical answer to the same request<br>SR-20 gives the same answer from another directory, with a relative package path | all |  |  |
| SR-21 | SR-21 runs with read-only files, no processes and no network<br>SR-21 passes its own package with zero declared systems | all |  | CI runs the suite and the conformance cases under `--permission` |
| SR-22 | SR-22 refuses a program that imports a file the review does not read<br>SR-22 passes a program that imports only shipped files<br>SR-22 refuses an unread file however the specifier is written<br>SR-22 refuses a specifier that resolves to no shipped file the way Node resolves it<br>SR-22 refuses a Python import of a test module however it is written<br>SR-22 reads a Python program as Python reads it: its encoding, its strings and its line endings<br>SR-22 does not count import text inside a Python f-string or a continued string<br>SR-22 does not count import text that a literal or a comment only contains<br>SR-22 passes a specifier that resolves to a shipped file, a dependency or a built-in<br>SR-22 findReach finds every import, re-export and require, and none a literal only contains | reach.mjs, rules.mjs |  |  |
| SR-23 | SR-23 refuses an mcp.json server the descriptor does not declare<br>SR-23 refuses an mcp.json that cannot be read<br>SR-23 refuses an undeclared server in .mcp.json or plugin.json | rules.mjs |  |  |

## Stage checks

| Check | Tool | Done when |
|---|---|---|
| Suite fails against empty stand-ins | `tools/removal-check.mjs` | 0 tests pass |
| Each program removed is noticed | `tools/removal-check.mjs` | at least 1 test fails per program |
| Statement and tests unchanged by the Code stage | `tools/lock.mjs --verify`, CI diff against `handoff` | no locked file changed, added or removed |
