#!/usr/bin/env bash
# The Test stage's handoff. Proves the suite fails against the empty stand-ins, locks what the
# Code stage may not change, commits, tags `handoff`, creates the GitHub repository, pushes,
# and protects `main` and the tag. Runs once. Moving the tag later is the spec owner's act.
#
# Usage: bash tools/handoff.sh <owner>/<repo> [--public]
#
# Reopening the Test stage later, as the spec owner: change the locked files, then run
#   node tools/removal-check.mjs && node tools/lock.mjs --write && git commit -am "Re-lock"
# lift the "handoff tag is fixed" ruleset, run git tag -f handoff && git push -f origin handoff,
# and restore the ruleset.
set -euo pipefail

repo="${1:?usage: bash tools/handoff.sh <owner>/<repo> [--public]}"
visibility="--private"
[ "${2:-}" = "--public" ] && visibility="--public"
cd "$(dirname "$0")/.."

command -v gh >/dev/null || { echo "gh is required: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run gh auth login"; exit 1; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || { echo "Node 22.13 or later is required: the suite runs the reviewer under --permission"; exit 1; }
if git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse -q --verify refs/tags/handoff >/dev/null; then
  echo "the handoff tag already exists; this script runs once"; exit 1
fi
if gh repo view "$repo" >/dev/null 2>&1; then
  echo "$repo already exists on GitHub; pick another name or delete it first"; exit 1
fi

echo "== the Test stage's done check: no test passes against the empty stand-ins"
node tools/removal-check.mjs

echo "== lock"
node tools/lock.mjs --write
node tools/lock.mjs --verify

echo "== commit and tag"
[ -d .git ] || git init -q -b main
git add -A
git commit -q -m "Test stage handoff: statement, suite, stand-ins, harness and guardrails"
git tag -a handoff -m "Test stage handoff. The Code stage may change only the paths in tools/lock.mjs WRITABLE."

echo "== publish"
gh repo create "$repo" "$visibility" --source . --remote origin --push
git push -q origin handoff

echo "== protect main and the handoff tag"
gh api -X POST "repos/$repo/rulesets" --input - >/dev/null <<'JSON' && echo "tag ruleset: active" || echo "tag ruleset: NOT created (rulesets on private repositories may need a paid plan); protect the tag by hand"
{
  "name": "handoff tag is fixed",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/handoff"], "exclude": [] } },
  "rules": [
    { "type": "update", "parameters": { "update_allows_fetch_and_merge": false } },
    { "type": "deletion" }
  ]
}
JSON
# A merge needs one approval from someone other than its author (GitHub never counts the author's
# own) and the code owner's for locked paths. 15368 is the GitHub Actions app, so only a workflow
# run can satisfy the verify check.
gh api -X POST "repos/$repo/rulesets" --input - >/dev/null <<'JSON' && echo "main ruleset: active" || echo "main ruleset: NOT created (rulesets on private repositories may need a paid plan); protect main by hand"
{
  "name": "main takes green, approved pull requests",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "dismiss_stale_reviews_on_push": false, "require_code_owner_review": true,
        "require_last_push_approval": true, "required_approving_review_count": 1,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "verify", "integration_id": 15368 }] } }
  ]
}
JSON

echo "== done: https://github.com/$repo (tag: handoff)"
