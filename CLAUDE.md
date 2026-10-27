# CLAUDE.md

This repository builds the **security reviewer**, one role in the Agent Development Lifecycle
(ADLC). The ADLC's Requirements, Design and Test stages are done. You hold the **Code stage**,
the role `code writer` at agentroles.ai.

## Your inputs, read-only

- `docs/spec.md`: the statement of the job, requirements SR-01 to SR-23.
- `docs/traceability.md`: requirement to test to program.
- `agents/security-reviewer/test/`: the suite, its helpers and the empty stand-ins.
- `agents/security-reviewer/*.json`, `skills/`: the package declaration.
- Everything else outside the paths below.

A hook blocks edits to these paths. `tools/lock.mjs --verify` and CI catch any other route.
A test that cannot pass without changing the statement or a test is a **conflict**. Stop and
report it in `docs/rounds.md`. Never resolve it yourself.

## What you may write

- `agents/security-reviewer/scripts/`: the six programs, as `.mjs` files. Keep the exported
  names the unit tests import; the other stand-ins' names are the design's split. Add no
  module: the locked `plugin.json` lists the six, and the lock refuses any other file there.
- `docs/rounds.md`: your record of each round.
- `README.md`: status lines only.

## Constraints

- Node 22 built-ins only. No dependencies, no `npm install`.
- No model calls, no network, no child processes, no file writes. The suite runs the reviewer
  under `node --permission --allow-fs-read=*` with network calls trapped.
- The reviewer reviews its own package (SR-21). Its own programs must contain no URL outside
  comments, no credential-like environment read, and no file that matches its own credential
  patterns. Write each pattern so it does not match its own source text.
- Deterministic output: sorted walks, no timestamps, no randomness.

## Commands

| Command | What it checks |
|---|---|
| `npm test` | lock holds, then the full suite |
| `npm run conformance` | the §34.4 behavioral cases |
| `npm run removal` | suite fails against stand-ins; notices each program removed |
| `npm run verify` | all three |

## Verifying your work

Run `npm run verify` before reporting any task done, and paste its output. Healthy output shows
`lock holds: N files unchanged`, `# fail 0`, `4 of 4 cases pass`,
`pass  with the programs: N of N traced tests pass, by name`, and
`pass  against empty stand-ins: 0 of N tests pass (must be 0, with all N traced tests run)`.

## Done when

All three commands exit 0, no locked file changed, and `docs/rounds.md` records every round:
what failed, what changed, and anything the statement did not settle.
