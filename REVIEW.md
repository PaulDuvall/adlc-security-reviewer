# Review instructions

Run three passes and tag each finding with its pass.

- **Bugs:** logic errors, broken edge cases and regressions in `agents/security-reviewer/scripts/`.
- **Security:** reach a statement could miss, a credential an answer could repeat, and any write,
  process or connection the reviewer could open, and code or an MCP server it could leave
  unread (SR-08, SR-13, SR-21, SR-22, SR-23).
- **Compliance:** each change cites the requirement it serves in `docs/spec.md`; every test
  still has its row in `docs/traceability.md`; `docs/rounds.md` records the round; no locked
  file changes outside a spec-owner reopen.

Important means a requirement is broken or weakened. Style and naming are nits: report at most
five and count the rest.

A pull request that changes `.github/`, `tools/`, `.claude/`, `LOCK.json`, `CLAUDE.md`,
`docs/spec.md`, `docs/traceability.md` or the tests changes what judges the code: CI runs the
checks as that pull request writes them. Report every such change as important, so the spec
owner reviews it, whatever CI says.

Do not report what CI already enforces: the lock, the handoff diff, the suite, the conformance
cases, the removal check and gitleaks.
