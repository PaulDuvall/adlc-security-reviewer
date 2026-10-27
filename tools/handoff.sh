#!/usr/bin/env bash
# The Test stage's handoff. Proves the suite fails against the empty stand-ins, locks what the
# Code stage may not change, commits, tags `handoff`, creates the GitHub repository, pushes,
# and protects `main` and the tag. Runs once. Moving the tag later is the spec owner's act.
#
# Usage: bash tools/handoff.sh <owner>/<repo> [--public]
#
# Reopening the Test stage later, as the spec owner, on main: change the locked files, then
#   node tools/removal-check.mjs && node tools/lock.mjs --write && git add -A && git commit -m "Re-lock"
# (`git add -A` takes new files too, which LOCK.json lists), without pushing it yet. Lift the
# "handoff tag is fixed" ruleset, move the tag to that commit, push the tag, restore the ruleset,
# and only then push main:
#   git tag -fa handoff -m "Test stage reopen" && git push -f origin handoff && git push origin main
# CI's diff and lock steps compare with the tag, so a run that starts before the tag moves stays
# red. Pushed in this order, main's run sees the moved tag. Commits after the re-lock may touch
# only the Code stage's paths.
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
[ -d .git ] || git init -q -b main
node tools/lock.mjs --write
node tools/lock.mjs --verify

echo "== commit and tag"
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
# Work lands on main directly, with no pull request: main cannot be deleted or rewritten, and
# CI checks every push. The lock, the CI diff against the tag and the write hook keep the Code
# stage off the locked files; a push that changes one turns CI red.
gh api -X POST "repos/$repo/rulesets" --input - >/dev/null <<'JSON' && echo "main ruleset: active" || echo "main ruleset: NOT created (rulesets on private repositories may need a paid plan); protect main by hand"
{
  "name": "main keeps its history",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON

echo "== done: https://github.com/$repo (tag: handoff)"
