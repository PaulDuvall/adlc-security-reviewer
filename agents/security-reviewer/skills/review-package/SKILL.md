---
name: review-package
description: Review one Agent Package before it is installed, and answer with a security statement or a refusal.
---

# Review this package

Run `scripts/review.mjs` with one `security-review-request-v1` request on standard input.
It writes one answer to standard output: `passed` with a statement, `refused` with every
refusal found, or `declined`.

Every decision is made by the scripts. No model is called and no network is opened.

The request and answer formats, the rules and the terms are in `docs/spec.md` of the
source repository.
