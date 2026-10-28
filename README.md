# adlc-security-reviewer

[![verify](https://github.com/RedactedVentures/adlc-security-reviewer/actions/workflows/verify.yml/badge.svg)](https://github.com/RedactedVentures/adlc-security-reviewer/actions/workflows/verify.yml)

A security gate for AI agents. Before anyone installs an agent, this reviewer reads the agent's
package. It checks what the code really reaches against what the package declares. Then it
gives one of three answers: **passed**, with a security statement; **refused**, with every
problem listed; or **declined**, when asked to do more than review.

It implements the security reviewer, one of the roles in the Agent Development Lifecycle (ADLC).
The role is defined in [ROLES.md §34](https://github.com/CommonAgent/common-agent-standards/blob/main/roles/ROLES.md#34-role-the-security-reviewer) of the Common Agent
Standards, summarized at [agentroles.ai/security-reviewer](https://agentroles.ai/security-reviewer.html),
and its stage is at [agenticdevelopment.ai](https://agenticdevelopment.ai/stages.html#security).

> This is an independent implementation by Redacted Ventures LLC. It is not made, reviewed or
> endorsed by AgentMesh, Inc., by Jeff Schneider, or by the editors of the Agent Development
> Lifecycle or the Common Agent Standards.

## Where it stands

Status on 28 October 2026. Spec 0.3.0, its 180 tests and round 15's licence, notices and
security policy are locked at `3030158`, and every check on GitHub passes. The tests catch 91.8% of
the bugs planted in round 13's code. Round 17 sorted the 293 they miss: 34 showed 17 real
bugs, all fixed, and 70 more are tests the suite lacks. Open: 28 decisions the spec leaves
open, and the 104 tests round 17 found missing.

| | Check | Result |
|---|---|---|
| ✅ | Automated checks on GitHub | Pass on `3030158`, the latest re-lock |
| ✅ | Spec | Version 0.3.0, with 23 numbered requirements |
| ✅ | Tests | 180 of 180 pass. Each one traces to a requirement |
| ✅ | Role checks | 4 of 4 pass. These are the four scenarios [ROLES.md §34.4](https://github.com/CommonAgent/common-agent-standards/blob/main/roles/ROLES.md#344-conformance-testing-the-security-reviewer) requires. The check is local: no official one is published yet |
| ✅ | The tests catch broken code | With the 6 programs emptied, 0 of 180 tests pass. Deleting any one program makes 122 to 157 of the 180 tests fail |
| ✅ | The AI that wrote the code cannot change the tests unseen | A fingerprint covers 35 files, including the spec and the tests. Changing any of them fails the checks on GitHub |
| ✅ | Planted-bug check | Small bugs are planted in copies of the code to see how many the tests catch; the usual target is 80% ([Stryker's default](https://stryker-mutator.io/docs/stryker-js/configuration/#thresholds-object)). Now, on round 13's code and 180 tests: 91.8% of all 3,557, with 293 surviving, measured before round 17's fixes. Before the spec 0.3.0 reopen, on 87 tests: 70.8% of 3,464. Round 8: 67.4% of 3,304 |
| 🟡 | Open decisions | [11 questions the spec leaves open](docs/spec.md#open-questions), and [17 points where the spec is still silent and the code made its own choice](docs/rounds.md#points-the-statement-does-not-settle). Spec 0.3.0 settled 5 of 21; round 17 added U22 |

## What it does for users

It reads the agent's package and the owner's spending limit. It checks every system the code
really contacts against what the package declares. Then it gives one of three answers.

```mermaid
flowchart LR
  pkg["<b>The agent package</b><br/>from its publisher<br/>what it says it reaches, and why<br/>its programs and files"]
  lim["<b>The owner's limits</b><br/>a spending limit, here $5.00 a day"]
  rev["<b>Security reviewer</b><br/>reads every shipped file<br/>checks what the code reaches<br/>against what the package declares<br/><i>no model, no network, changes nothing</i>"]
  pass["<b>Passed: a security statement</b><br/>Reaches ticket-store, read access<br/>Why: to read the tickets it summarizes<br/>Spends at most $5.00 a day<br/>Never writes to the ticket store"]
  ref["<b>Refused: every problem named</b><br/>Reaches api.billing.example.com, line 9<br/>Reads the secret BILLING_API_KEY,<br/>never declared, line 10<br/>No reason given for ticket-store<br/>No spending limit set by the owner"]
  dec["<b>Declined: asked to hand over a credential</b><br/>It only reviews. It never grants access,<br/>hands out credentials or installs anything"]
  pkg --> rev
  lim --> rev
  rev --> pass
  rev --> ref
  rev --> dec
  classDef gate stroke:#0969da,stroke-width:2px
  classDef ok stroke:#1a7f37,stroke-width:2px
  classDef no stroke:#cf222e,stroke-width:2px
  class rev gate
  class pass ok
  class ref no
```

The passed answer is a real run on the suite's sample agent, `ticket-reader`, with a $5.00 daily
limit. The refused answer is the same agent with four faults added: a billing web address, a
billing key, an empty reason and no limit. The reviewer's output on `main` matches both.

| Who | What they get | Why it matters |
|---|---|---|
| The owner installing an agent | A statement of every system the agent reaches, with its access and reason, what it may spend, what it must never do, and the risks the owner accepts by installing it | What the code reaches is checked against the code. The reasons and the "never" list are the publisher's own words, shown as written |
| The agent's publisher | A refusal that lists every problem found, with the file and line where one applies | Fixes come in one batch, not one problem at a time |
| The platform or security team | The same answer for the same request every time, stamped with the package's fingerprint (its digest). The reviewer never grants anything itself | The answer can serve as the record of the install decision. Changing one byte of a shipped file changes the fingerprint |

One judgment stays with a person: whether each stated reason is good enough. The answer shows
every reason and lists this judgment as not checked.

## Use it on your agent

You have built an agent and want it on AgentMesh. Run this review before you package or
deploy it. It names, in one answer, everything this reviewer would refuse.

### Where it fits

The review is stage 08 of the [Agent Development Lifecycle](https://agenticdevelopment.ai/stages.html).
It comes after your code is written and reviewed, and before the agent is packaged and
deployed. An agent joins the mesh at Deploy, stage 11, so the review comes first: the limits
are set before any credential is placed.

```mermaid
flowchart LR
  code["<b>06 Code, 07 Review</b><br/>your programs"]
  decl["<b>Your declarations</b><br/>agent-descriptor.json<br/>agent-runtime-requirements.json"]
  rev["<b>08 Security review</b><br/>this reviewer, on your machine"]
  pkg["<b>09 Package, 10 Release</b><br/>package maker"]
  dep["<b>11 Deploy</b><br/>deployment manager<br/>onto an AgentMesh fleet host"]
  con["<b>12 Conformance</b><br/>conformance checker"]
  code --> rev
  decl --> rev
  rev -->|"passed"| pkg
  rev -->|"refused: fix, run again"| code
  pkg --> dep --> con
  rev -.->|"the statement:<br/>hand-off not yet defined"| dep
  classDef gate stroke:#0969da,stroke-width:2px
  classDef open stroke:#9a6700,stroke-width:2px,stroke-dasharray:4
  class rev gate
  class dep open
```

The lifecycle does not settle three points yet.

| Gap | What to do for now |
|---|---|
| The [stages page](https://agenticdevelopment.ai/stages.html) lists the two declaration files as outputs of Package, stage 09. The reviewer reads them, so it cannot run without them | Write both files before the review. The package maker can start from them |
| [ROLES.md §34.3](https://github.com/CommonAgent/common-agent-standards/blob/main/roles/ROLES.md#34-role-the-security-reviewer) calls the statement the record, and names no one who reads it next | Keep the statement with the install decision, and give it to whoever deploys the agent |
| Running on a fleet host needs a host contract AgentMesh has not published ([spec](docs/spec.md#out-of-scope-for-030)) | Run it locally, as below |

### What you need

| Need | Detail |
|---|---|
| Node 22.13 or later, and a clone of this repo | No dependencies, no install step |
| Your agent's folder | `agent-descriptor.json`, `agent-runtime-requirements.json`, every file you ship, and optionally `plugin.json` for the name and version |
| The owner's spending limit | In millionths of the currency: `5000000` is $5.00 |
| The owner's number for each ceiling | Only where your runtime requirements list `ceilings` |

### Run it

Write the request to `request.json`:

```json
{
  "review": "v1",
  "ask": "review",
  "package": "/path/to/your-agent",
  "owner": {
    "spend_limit": { "most_micro": 5000000, "currency": "USD", "per": "day" },
    "ceilings": []
  }
}
```

`package` may be relative to the folder you run from. Each `ceilings` entry gives the owner's
`most` for one entry in your runtime requirements, matched on `system` and `per`.

From the root of this repo:

```bash
node --permission --allow-fs-read='*' agents/security-reviewer/scripts/review.mjs < request.json
```

The flags make Node itself refuse any file write or new process. The reviewer writes one line
of JSON and exits 0, whatever the answer.

To try it before writing your own request, run one of the sample agents in
[`examples/`](examples/). Each request's answer is recorded in `examples/answers/`, and the suite
checks that the reviewer still gives it:

```bash
node --permission --allow-fs-read='*' agents/security-reviewer/scripts/review.mjs < examples/requests/review-faults.json
```

### Read the answer

| Answer | What it means | Next |
|---|---|---|
| `passed` | A `statement`: each system reached, its access and reason, the limit, what it must never do, what was accepted knowingly, and what was not checked | Package and release it. Run the review again after any change: one changed byte changes the digest |
| `refused` | Every problem found, each with a `rule`, and the file and line where one applies | Fix them all, then run again |
| `declined` | The request asked for something other than a review | Ask for `review`. It never grants, binds or installs |

The answer to `examples/requests/review-faults.json`, in full. Its sample agent,
[`examples/ticket-reader-faults`](examples/ticket-reader-faults/), has the four faults the
diagram above shows: a hard-coded billing address, an undeclared billing key, a blank reason
and no spending limit. It adds them as a second function, so they sit on lines 11 and 12.

```json
{
  "result": "refused",
  "package": { "name": "ticket-reader", "version": "0.1.0", "digest": "sha256:cc4831d4…" },
  "refusals": [
    { "rule": "no-reason", "system": "ticket-store",
      "why": "the descriptor records no reason (needs) for reaching ticket-store" },
    { "rule": "undeclared-reach", "system": "api.billing.example.com",
      "file": "skills/read-tickets/scripts/read.mjs", "line": 11,
      "why": "the program reaches api.billing.example.com by a URL in its code, not through a system the host binds" },
    { "rule": "undeclared-reach", "system": "BILLING_API_KEY",
      "file": "skills/read-tickets/scripts/read.mjs", "line": 12,
      "why": "the program reads the credential-like variable BILLING_API_KEY, which the runtime requirements do not bind" },
    { "rule": "spend-limit", "why": "the owner set no spending limit" }
  ]
}
```

### Fix the usual first refusal

Most agents are refused first for a web address written in their code. Declaring the system
is not enough: the address must come from a setting the host binds.

```js
// Refused: the host is in the code
fetch("https://api.billing.example.com/charge", { headers: { authorization: process.env.BILLING_API_KEY } });

// Passes: the host and the key both come from what the runtime requirements bind
fetch(`${process.env.BILLING_URL}/charge`, { headers: { authorization: process.env.BILLING_API_KEY } });
```

Then declare the system in both files. In `agent-descriptor.json`:

```json
{ "name": "billing", "access": "write", "needs": "to charge for each summary" }
```

In `agent-runtime-requirements.json`:

```json
{
  "name": "billing", "kind": "service", "credential": "billing-key", "env": "BILLING_API_KEY",
  "settings": [{ "env": "BILLING_URL", "purpose": "where billing answers" }]
}
```

The review then passes, and lists `billing` under `accepted_knowingly`, since its access is
`write`. [`examples/`](examples/) holds both versions: `ticket-reader-billing-hardcoded`
and `ticket-reader-billing`. A web address in a comment does not count. One in a string
does, even one used only as a name, such as a JSON Schema address
([open question 5](docs/spec.md#open-questions)).

### Every refusal rule

| Rule | Cause | Usual fix |
|---|---|---|
| `bad-request` | The request is not valid JSON, lacks `"review": "v1"`, or names no package | Match the request above |
| `unreadable` | The folder is missing, a declaration file is not a JSON object, or an `mcp.json` cannot be read | Fix the file it names |
| `systems-mismatch` | The two declaration files name different systems | Name each system in both |
| `no-reason` | A system has a missing or blank `needs` | Say why the agent needs it |
| `undeclared-reach` | A program contains a web address or reads an unbound credential-like variable, or an MCP server is not a declared system | Declare the system, bind its credential and address, and read both from the environment |
| `spend-limit` | The owner's limit is missing or malformed | Set `owner.spend_limit` |
| `ceiling-missing` | A system that spends has no ceiling, or says the wrong side enforces it | Add a ceiling. A system with a credential needs `enforced_by: runtime` |
| `ceiling-unset` | The owner gave no number for a ceiling | Add it under `owner.ceilings` |
| `credential-in-files` | A shipped file holds a credential | Remove it and rotate it. The answer names the file and kind, never the value |
| `dependency-unpinned` | A lockfile is missing, differs from its `sha256`, or leaves a package without `integrity` | Ship the lockfile and record its `sha256` |
| `unread-code` | A program loads code the review does not read | Load only shipped files, dependencies and built-ins |

### What a pass does not cover

A pass is not a full audit. `not_checked` lists what was not checked, including known
vulnerabilities in dependencies and addresses built at runtime. A person still decides whether
each reason is good enough. The digest covers your package folder, not the release archive,
so it will not match the digest Release records ([open question 7](docs/spec.md#open-questions)).

#### Known gaps

A pass means the package has none of the faults the reviewer looks for. It is not yet proof
against a publisher who sets out to get past it. These pass today:

| Gap | What gets past | Where it is tracked |
|---|---|---|
| Other ways to load code | `require.call`, `require.apply`, `Reflect.apply`, an alias of `require`, `new Worker(…)`, `__import__`, `runpy` or a `.pth` file can load a file the reviewer never read. `not_checked` does not name them | [Open question 8](docs/spec.md#open-questions) |
| What a tool server runs | A declared MCP server's `command` may run an unshipped file, and its `url` may name any host | [Open question 9](docs/spec.md#open-questions) |
| Links to folders | Files reached only through a symbolic link to a folder are not read | [Open question 10](docs/spec.md#open-questions) |
| Old npm lockfiles | A version-1 `package-lock.json` has no entries the pin check reads, so an unpinned one passes without a mention | [Open question 11](docs/spec.md#open-questions) |
| An alias of the environment | `const e = process.env; e.BILLING_API_KEY` is not seen as a read | [U10](docs/rounds.md#points-the-statement-does-not-settle) |
| Addresses built at runtime | A host or module path computed by the code, such as `` `https://${host}/` ``, is not refused. `not_checked` says such destinations were not checked | [U8](docs/rounds.md#points-the-statement-does-not-settle) |
| Credentials of other kinds | Shipped files are searched for 7 patterns: private keys, PKCS#12 keystores, service-account keys, AWS keys and NKey seeds. Any other secret string passes | SR-13 |

Report a way past the reviewer privately, as [SECURITY.md](SECURITY.md) says. These gaps are
already known.

## What has been done

This repo was built in the ADLC's four build stages: requirements, design, tests and code. All
four are done.

```mermaid
flowchart LR
  req["<b>Requirements</b> ✅<br/>spec 0.3.0<br/>23 requirements"]
  des["<b>Design</b> ✅<br/>each requirement traced<br/>to its tests and its program"]
  tst["<b>Test</b> ✅<br/>180 tests, 4 role checks<br/>35 files locked"]
  cod["<b>Code</b> ✅<br/>6 programs, 1,662 lines<br/>Node built-ins only<br/>17 rounds"]
  nxt["<b>Next</b><br/>104 missing tests added<br/>28 open decisions settled"]
  req --> des --> tst --> cod -.-> nxt
  classDef done stroke:#1a7f37,stroke-width:2px
  classDef next stroke:#9a6700,stroke-width:2px,stroke-dasharray:4
  class req,des,tst,cod done
  class nxt next
```

The Code stage ran in seventeen rounds. Round 1 wrote the code, and round 5 built spec 0.2.0. The
other rounds attacked the code and fixed what broke, except rounds 10, 14 and 15, which changed
the checks and files around it, and round 16, which measured the tests.
[docs/rounds.md](docs/rounds.md) has the full record.

| Round | What was tried | What it found |
|---|---|---|
| 1 | Write the six programs | All 58 tests of the first spec pass |
| 2 | 36 extra checks on generated inputs | 6 bugs the tests missed, all fixed |
| 3 | Plant 1,578 bugs and see which the tests catch | The tests caught 64%. 4 more real bugs, all fixed |
| 4 | One targeted attack from the spec review | 1 bug, fixed: the reviewer skipped code placed after a rare line-break character |
| 5 | Spec 0.2.0 adds two rules: refuse code that loads files the reviewer does not read, and refuse undeclared tool servers. Other rules got stricter | Both built. 72 of 72 tests pass |
| 6 | Two independent reviews | About 20 ways an agent could load code the reviewer never checked, all fixed |
| 7 | Four review passes attack the code, and a skeptic re-checks each finding | 14 bugs confirmed and fixed. Python is now read by a tokenizer, not by pattern matching |
| 8 | A second attack review; 92,000 generated Python programs; a compile check on 6,771 JavaScript programs; 3,304 planted bugs | 7 bugs confirmed and fixed. Python: 0 differences from Python's own reader. JavaScript: no code hidden in 6,771 programs. The tests caught 67.4% of the planted bugs |
| 9 | Sort the 1,078 planted bugs the tests missed | 16 real bugs, all fixed. Two let an agent past the gate by writing a secret's name or a web address in escape codes |
| 10 | Make the file lock use git's list of files | Locking now works in any copy of the repo. A review found 7 issues in the change, all fixed. No program changed |
| 11 | Check the 58 test ideas against current code, then compare every legacy escape with Node | 1 bug, fixed: `require("./test\5710.js")` let an agent load an unread file past the gate. All 4,686 legacy escapes now decode as Node decodes them |
| 12 | Spec 0.3.0 and 84 new tests from the spec owner's reopen | 3 new tests failed until fixed: a specifier with an escape that cannot be decoded is refused, `process['env']` reads count, and an encoding declaration's line counts `\n` only. All 171 tests pass |
| 13 | An adversarial review of the reopen, then a comparison with Node of 1,716 environment-read forms | 6 gaps, all fixed: a 4,000-point program ran the reviewer out of memory; a long run of space took it quadratic time; `.mts`, `.cts` and `.pyw` programs went unread; an escape in `process` or `env` hid a read; overlapping credentials leaked a fragment; a `%5C` import was refused. 8 new tests; all 179 pass |
| 14 | Make `examples/` the code writer's, check each example's recorded answer, and check the README's figures on every push | No program changed. The examples test fails on a wrong recorded answer, and the README check on a stale figure. All 180 tests pass |
| 15 | Ready the repository for public release: licence, notices, a security policy and a review gate on main | No program changed but a comment. The project is MIT. The credential patterns copied from CommonAgent/adlc keep their Apache-2.0 notice, and the spec's adapted standard text its CC BY 4.0 credit. The write hook now blocks a write when it cannot run. `tools/handoff.sh` now sets rulesets where a pull request to main needs a code owner's approval and a green check, and only the owner may push past them |
| 16 | Plant all 3,557 bugs in round 13's code and run the 180 tests on each | The tests caught 91.8%, up from 70.8% before the spec 0.3.0 reopen. Of the bugs the 87 tests missed and that can be matched, 78% are now caught, and no bug caught before is missed now. 293 survive, not yet sorted |
| 17 | Sort the 293 surviving planted bugs: for each, a request whose answer it changes, or a reason nothing can, then a skeptic's re-check | 17 real bugs, all fixed. The worst: a URL hidden by `++` after a line end, by `extends /…/` or by `for await (`; a Python import swallowed by an f-string; `import "https:"` loading unshipped tests; an astral character that made the reviewer loop forever. 70 more are tests the suite lacks. Checked against CPython, V8 and Node, with no difference left in what they run |

## How the tests stay honest

The code writer is an AI agent. A hook stops it from editing the spec or the tests, and the
checks on GitHub fail on any push that changes them.

```mermaid
flowchart LR
  so["<b>Spec owner</b><br/>writes the spec and the tests"]
  lock["<b>The lock</b><br/>LOCK.json: a fingerprint of 35 files<br/>a git tag, handoff, marks where they were locked"]
  cw["<b>Code writer, an AI agent</b><br/>may change only the 6 programs,<br/>the round record, this README<br/>and the examples"]
  ci["<b>Checks on GitHub, on every push to main</b><br/>no credential in the history<br/>no locked file changed<br/>180 tests pass, 4 role checks pass<br/>emptied programs fail every test<br/>the README's figures are current"]
  so -->|"changes the spec or tests,<br/>then locks them again"| lock
  lock --> ci
  cw -->|"push"| ci
  classDef owner stroke:#0969da,stroke-width:2px
  classDef agent stroke:#9a6700,stroke-width:2px
  classDef gate stroke:#1a7f37,stroke-width:2px
  class so,lock owner
  class cw agent
  class ci gate
```

Only the spec owner can change the spec or the tests. Each change shows in git as its own
"Re-lock" commit.

## What is still open

| Item | Owner | Where |
|---|---|---|
| 104 tests round 17 found missing: 70 suite gaps, and 34 planted bugs that showed the 17 bugs it fixed | Spec owner, at the next reopen | [docs/rounds.md](docs/rounds.md#test-ideas-from-round-17) |
| Optional: apply the two rulesets `tools/handoff.sh` now sets, the owner's bypass on the `handoff` tag and main's review gate. Until then a re-lock lifts the tag's ruleset, and main takes any admin's push | Spec owner | [docs/rounds.md](docs/rounds.md), round 15; `tools/handoff.sh` |
| 11 questions the spec leaves open, such as other ways code can load code, what an agent's tool servers run, and old npm lockfiles | Spec owner: 7. Needs input from AgentMesh: 4, not yet raised with them | [docs/spec.md](docs/spec.md#open-questions) |
| 17 points where the spec is still silent and the code made its own choice | Spec owner may settle any | [docs/rounds.md](docs/rounds.md#points-the-statement-does-not-settle) |
| On a developer's own machine, the lock check skips files that local git settings hide: `.git/info/exclude`, global excludes or an untracked `.gitignore`. The checks on GitHub are unaffected | Spec owner; accepted as a known limit | [docs/rounds.md](docs/rounds.md), round 10 |

## How this repository is built

| Path | What it is | Who changes it |
|---|---|---|
| `docs/spec.md` | The job, as 23 requirements | Spec owner |
| `docs/traceability.md` | Each requirement, its tests and its program | Spec owner |
| `agents/security-reviewer/test/`, `conformance/` | The tests and the role checks | Spec owner |
| `CLAUDE.md`, `.claude/` | The code writer's instructions, and the hook that stops it editing locked files. They configure the AI agent that writes the code; a person using the reviewer needs neither | Spec owner |
| Everything else: `tools/`, `.github/`, `LOCK.json`, `LICENSE`, `NOTICE`, `SECURITY.md` | The lock, the checks, the licence and the security policy | Spec owner |
| `agents/security-reviewer/scripts/` | The six programs | Code writer |
| `docs/rounds.md`, `README.md` | The record of each round, and this page | Code writer |
| `examples/` | Sample agents, the requests [Use it on your agent](#use-it-on-your-agent) runs, and the answer recorded for each | Code writer; the suite checks each answer |

Run every check:

```bash
npm run verify
```

| Command | What it does |
|---|---|
| `npm test` | Checks no locked file changed, then runs the 180 tests |
| `npm run conformance` | Runs the 4 role checks |
| `npm run removal` | Checks the tests fail when the 6 programs are emptied, and when any one is deleted |
| `npm run readme` | Checks the README's figures against the repository: spec version, tests, rounds, program lines, locked files |
| `npm run verify` | Runs all four |

Node 22.13 or later and git. No dependencies.

## Licence

MIT: see [LICENSE](LICENSE). Two parts come from other works and keep their own terms. The
credential patterns in `secrets.mjs` are copied from [CommonAgent/adlc](https://github.com/CommonAgent/adlc)
under Apache-2.0, and `docs/spec.md` adapts passages of the [Common Agent Standards](https://github.com/CommonAgent/common-agent-standards)
under CC BY 4.0. [NOTICE](NOTICE) has the details.

To report a way past the reviewer, see [SECURITY.md](SECURITY.md).
