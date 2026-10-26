# adlc-security-reviewer

A reference implementation of the ADLC **security reviewer** role
([agentroles.ai/security-reviewer](https://agentroles.ai/security-reviewer.html), ROLES.md §34),
the Security review stage at [agenticdevelopment.ai](https://agenticdevelopment.ai/stages.html#security).

Status: Code stage done in two rounds ([docs/rounds.md](docs/rounds.md)). `npm run verify` exits 0.

| Path | Stage | Who changes it |
|---|---|---|
| `docs/spec.md`, `docs/traceability.md` | Requirements, Design | spec owner |
| `agents/security-reviewer/test/`, `conformance/` | Test | spec owner |
| `agents/security-reviewer/scripts/` | Code | code writer |
| `docs/rounds.md` | Code | code writer |

```bash
npm run verify   # suite, conformance cases, removal check, self-review
```

Node 22 or later. No dependencies.
