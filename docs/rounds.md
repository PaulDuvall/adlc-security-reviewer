# Rounds

The Code stage's record. One entry per round: what was run, what failed, what changed, and
anything the statement did not settle. Conflicts between a test and the statement go here,
unresolved, for the spec owner.

| Round | Ran | Failing before | Changed | Failing after | Notes |
|---|---|---|---|---|---|
| 1 | `npm run verify`; the CI conformance command, with `--permission` | 58 of 58 tests; 4 of 4 conformance cases; self-review | The six stand-ins replaced: `read-package.mjs` (106 lines), `reach.mjs` (263), `secrets.mjs` (40), `rules.mjs` (262), `statement.mjs` (52), `review.mjs` (75) | None. 58 of 58 pass; 4 of 4 cases; removing each program fails 41 to 46 tests; self-review passes | Built first in a scratch copy as a test oracle. No conflict between a test and the statement |

## Conflicts

None. Every test passes with the statement read as written.
