#!/usr/bin/env node
// PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit. Allows a write only inside the
// Code stage's paths (tools/lock.mjs WRITABLE). Exit 2 blocks the call and shows stderr to
// Claude. Fails closed: a call whose path cannot be read is blocked.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writable } from "../../tools/lock.mjs";

let event;
try { event = JSON.parse(readFileSync(0, "utf8")); } catch {
  process.stderr.write("guard-writes: the hook input is not JSON, so the write is blocked\n");
  process.exit(2);
}

const root = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
const input = event.tool_input ?? {};
const paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map((e) => e?.file_path) : [])]
  .filter((p) => typeof p === "string" && p);

if (!paths.length) {
  process.stderr.write(`guard-writes: no file path found in the ${event.tool_name} call, so it is blocked\n`);
  process.exit(2);
}

for (const p of paths) {
  const rel = relative(root, isAbsolute(p) ? p : resolve(root, p)).split(sep).join("/");
  if (rel.startsWith("..") || !writable(rel)) {
    process.stderr.write(
      `guard-writes: ${rel} is locked. The Code stage may write only agents/security-reviewer/scripts/, docs/rounds.md and README.md. `
      + "If a test or the statement seems wrong, record the conflict in docs/rounds.md and stop.\n",
    );
    process.exit(2);
  }
}
process.exit(0);
