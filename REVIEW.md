# Review instructions

Run three passes and tag each finding with its pass.

- **Bugs:** logic errors, broken edge cases and regressions in `agents/security-reviewer/scripts/`.
- **Security:** reach a statement could miss, a credential an answer could repeat, and any write,
  process or connection the reviewer could open (SR-08, SR-13, SR-21, SR-22).
- **Compliance:** each change cites the requirement it serves in `docs/spec.md`; every test
  still has its row in `docs/traceability.md`; `docs/rounds.md` records the round; no locked
  file changes outside a spec-owner reopen.

Important means a requirement is broken or weakened. Style and naming are nits: report at most
five and count the rest.

Do not report what CI already enforces: the lock, the handoff diff, the suite, the conformance
cases, the removal check and gitleaks.
