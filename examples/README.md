# Sample agents

Four versions of one sample agent, `ticket-reader`, which reads support tickets, and five
requests. Each request shows one answer the reviewer gives. The section
[Use it on your agent](../README.md#use-it-on-your-agent) walks through them.

| Request | Agent | Answer |
|---|---|---|
| `requests/review.json` | `ticket-reader`: one system, `ticket-store`, reached through a bound credential and setting | `passed` |
| `requests/review-faults.json` | `ticket-reader-faults`: a hard-coded billing address, an undeclared billing key, a blank reason, and no spending limit in the request | `refused`, 4 refusals |
| `requests/review-billing.json` | `ticket-reader-billing`: billing declared, its address and key read from bound settings | `passed`, `billing` under `accepted_knowingly` |
| `requests/review-billing-hardcoded.json` | `ticket-reader-billing-hardcoded`: billing declared, its address written in the code | `refused`, `undeclared-reach` |
| `requests/bind.json` | `ticket-reader`, asked to bind its credential | `declined` |

Run any of them from the root of this repo:

```bash
node --permission --allow-fs-read='*' agents/security-reviewer/scripts/review.mjs < examples/requests/review-faults.json
```

Each request names its agent relative to the repo root. The answers are the same on Node 22 and
Node 26, since no sample uses TypeScript.

`answers/` holds the answer the reviewer gives to each request, under the same file name. The
suite runs every request in `requests/` and fails if an answer differs from its recorded one,
so the examples stay true as the reviewer changes. After adding or changing an example, record
its answers again from the root of this repo:

```bash
for r in examples/requests/*.json; do node --permission --allow-fs-read='*' agents/security-reviewer/scripts/review.mjs < "$r" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2) + "\n")' > "examples/answers/$(basename "$r")"; done
```
