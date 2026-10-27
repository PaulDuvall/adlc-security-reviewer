# Security reviewer: statement of the job

Version 0.2.0. This file is the input to the Test and Code stages. It is locked at the
`handoff` tag. The Code stage reads it and never changes it.

## Sources

| Source | Pinned at |
|---|---|
| Role contract, ROLES.md §34, [CommonAgent/common-agent-standards](https://github.com/CommonAgent/common-agent-standards/blob/main/roles/ROLES.md#34-role-the-security-reviewer) | `058e5bd432f10a0d842da4926fa8fc3f77ea7ec0` (2026-10-25) |
| Agent Package §12.2 to §12.6, Common Agent Specification | same commit |
| Lifecycle stage "Security review", [agenticdevelopment.ai/stages.html#security](https://agenticdevelopment.ai/stages.html#security) | read 2026-10-26, v0.3.0-draft |
| Credential patterns, `agents/publisher/scripts/inspect.mjs`, [CommonAgent/adlc](https://github.com/CommonAgent/adlc) | `fa174cf88c22db8599f6447dbc40740cf046c36a` (2026-10-24) |

## What it does

Reads an Agent Package and the spending limit its owner set. Hands back a statement of what
the agent may reach and why, what it may spend, what it must never do, and what was accepted
knowingly. Or refuses, naming everything that stopped it.

## What it refuses

- Granting, binding, installing or changing anything.
- Passing an access with no reason.
- Passing a package whose programs reach something the declaration does not name.
- Passing a package whose owner set no spending limit.
- Repeating a credential value it found, in any answer.

## What it needs

No system. No model. No network. It reads the package directory it is handed.

## What it records

The statement or the refusal, which is its reply (ROLES.md §34.3). It writes no file.

## What it costs

Free.

## Interface

One request on standard input, one JSON answer on standard output. The command:

```bash
node agents/security-reviewer/scripts/review.mjs < request.json
```

### Request, `security-review-request-v1`

```json
{
  "review": "v1",
  "ask": "review",
  "package": "/abs/or/relative/path/to/package",
  "owner": {
    "spend_limit": { "most_micro": 5000000, "currency": "USD", "per": "day" },
    "ceilings": [{ "system": "text-reasoning", "per": "task", "most": 40 }]
  }
}
```

- `package` is resolved against the reviewer's working directory when relative.
- `spend_limit.most_micro` is a non-negative integer of micro-units. `currency` is three
  uppercase letters. `per` is `task` or `day`. This mirrors the allowance, Common Agent
  Specification §7.5.
- `owner.ceilings` supplies the owner's number for each entry in the package's
  `agent-runtime-requirements.json` `ceilings[]`, matched on `system` and `per`.

### Answers

Passed:

```json
{
  "result": "passed",
  "statement": {
    "format": "security-statement-v1",
    "package": { "name": "ticket-reader", "version": "0.1.0", "digest": "sha256:<64 hex>" },
    "reaches": [
      { "system": "ticket-store", "access": "read", "why": "<descriptor needs>",
        "kind": "service", "credential": "ticket-store-token" }
    ],
    "spends": {
      "limit": { "most_micro": 5000000, "currency": "USD", "per": "day" },
      "ceilings": [{ "system": "text-reasoning", "per": "task", "most": 40, "enforced_by": "runtime" }]
    },
    "never": ["<each line of the descriptor's refusals>", "reach any destination outside the systems in reaches"],
    "accepted_knowingly": [{ "what": "<short sentence>", "system": "<optional>", "file": "<optional>", "why": "<short sentence>" }],
    "not_checked": ["<short sentence>"],
    "decided_by": "rule"
  }
}
```

Refused:

```json
{
  "result": "refused",
  "package": { "name": "ticket-reader", "version": "0.1.0", "digest": "sha256:<64 hex>" },
  "refusals": [
    { "rule": "undeclared-reach", "system": "api.billing.example.com",
      "file": "skills/read/scripts/read.mjs", "line": 12, "why": "<short sentence>" }
  ]
}
```

`package` is present when the package could be read. Each refusal carries `rule` and `why`,
plus `system`, `file` and `line` where they apply.

Declined:

```json
{ "result": "declined", "why": "<short sentence>" }
```

## Terms

- **Shipped file.** Any file under the package directory except those with a path segment
  of `test`, `tests`, `node_modules` or `.git`, and except names matching `*.test.*`.
- **Program.** A shipped file ending `.mjs`, `.js`, `.cjs` or `.ts` (JavaScript) or `.py`
  (Python).
- **Package digest.** `sha256:` followed by the hex SHA-256 of the concatenation, in
  byte-wise sorted path order, of one line per shipped file: the POSIX relative path, a NUL
  byte, the file's hex SHA-256, and a newline. It is this reviewer's digest of the package
  directory, not the archive digest of Common Agent Specification §12.6 rule 5 (open question 7).
- **Credential-bearing system.** A runtime requirements system with a non-blank `credential`.
- **Credential-like name.** An environment variable name with at least one `_`-separated
  part in: `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `CREDENTIALS`,
  `AUTH`, `PAT`. Case-insensitive. `TEXT_API_KEY` is one; `AUTHOR_NAME` is not.
- **Bound name.** An environment variable named by any `systems[].env` or
  `systems[].settings[].env` in the runtime requirements.
- **Spending system.** A runtime requirements system with a `spends` member.
- **Package name and version.** `name` and `version` from `plugin.json`. Where it is absent,
  the package directory's name and the descriptor's `agent_version`.
- **Line.** 1-based line number in the program file.

## Requirements

EARS form. Each has a test, listed in [traceability.md](traceability.md).

| ID | Requirement |
|---|---|
| SR-01 | The reviewer shall read one request from standard input and write exactly one JSON object, on one line, followed by a newline, to standard output, and exit 0. |
| SR-02 | When the request is not valid JSON or does not carry `"review": "v1"`, the reviewer shall refuse with rule `bad-request`. |
| SR-03 | When `ask` is anything other than `review`, the reviewer shall answer `declined`, and its `why` shall say it grants, binds, installs and changes nothing. |
| SR-04 | The reviewer shall not create, modify or delete any file under the package directory, for any request. |
| SR-05 | If the package directory is missing, or neither `agent-descriptor.json` nor its former name `descriptor.json` parses as JSON, or neither `agent-runtime-requirements.json` nor its former name `install.json` parses as JSON, then the reviewer shall refuse with rule `unreadable`. Where a current and a former name are both present, the current name shall be read. |
| SR-06 | If the system names in the descriptor's `systems[]` and the runtime requirements' `systems[]` differ as sets, then the reviewer shall refuse with rule `systems-mismatch`, one refusal per system found in only one file. |
| SR-07 | If a descriptor system has a missing or blank `needs`, then the reviewer shall refuse with rule `no-reason`, naming the system. |
| SR-08 | If a program contains an `http`, `https`, `ws` or `wss` URL, in any letter case, in executable code, then the reviewer shall refuse with rule `undeclared-reach`, with `system` set to the hostname a WHATWG URL parser gives for it (lowercase, no port), plus `file` and `line`. A URL inside a comment shall not count. A JavaScript comment ends at any ECMAScript line terminator; a Python comment ends at `\n` or `\r`. In a `.cjs` program, `<!--`, and `-->` at a line's start, also begin a line comment, as Node.js reads a script. Where the reviewer cannot tell how a JavaScript program reads (whether a `/` begins a regular expression or a division, or whether a `.js` or `.ts` program is a script), it shall take for code what any reading takes for code, here and in SR-09, SR-17 and SR-22. |
| SR-09 | If a program reads a credential-like environment variable that is not a bound name, then the reviewer shall refuse with rule `undeclared-reach`, with `system` set to the variable name, plus `file` and `line`. Reads recognized: JavaScript `process.env.NAME`, `process.env["NAME"]`, `process.env['NAME']`, and destructuring from `process.env`; Python `os.environ["NAME"]`, `os.environ.get("NAME")`, `os.getenv("NAME")`. In JavaScript, space or a comment may sit around each `.` of a read. |
| SR-10 | If the owner's `spend_limit` is missing or malformed per the request schema, then the reviewer shall refuse with rule `spend-limit`. |
| SR-11 | If a spending system has no `ceilings[]` entry, or a `ceilings[]` entry has an `enforced_by` other than `runtime` or `platform`, or says `platform` for a credential-bearing system, then the reviewer shall refuse with rule `ceiling-missing`, naming the system. Common Agent Specification §12.4 item 4: the scripts reach such a system themselves, so only the runtime can count what it spends. |
| SR-12 | If a `ceilings[]` entry has no `owner.ceilings` entry with the same `system` and `per` and a non-negative numeric `most`, then the reviewer shall refuse with rule `ceiling-unset`, naming the system. |
| SR-13 | If any shipped file matches a credential pattern from the publisher's list, then the reviewer shall refuse with rule `credential-in-files`, naming the file and the kind of credential. No answer shall contain the matched text in any letter case, wherever it would appear, including in a name or a host the answer repeats. |
| SR-14 | If a runtime requirements `dependencies[]` entry names a `lockfile` that is not a shipped file, or a `sha256` that differs from that file's digest, or the lockfile is npm format and any entry under `packages` other than the root lacks `integrity`, then the reviewer shall refuse with rule `dependency-unpinned`, naming the lockfile. |
| SR-15 | When more than one refusal rule applies, the reviewer shall list every refusal found in one answer. |
| SR-16 | When no refusal rule applies, the reviewer shall answer `passed` with a statement in which every declared system appears in `reaches` with its access and a non-empty `why`, and with `leaves` only where the descriptor or the runtime requirements state it (Common Agent Specification §6.4 rule 2: absent means not stated), true where either states any value but `false`; `spends.limit` equals the owner's limit, member for member; and `spends.ceilings` lists every ceiling with the owner's number and its `enforced_by`. |
| SR-17 | The statement's `accepted_knowingly` shall carry one entry for each of: a system with access other than `read`; a system that content leaves for (SR-16); a ceiling with `enforced_by: runtime`; a program that imports `child_process` (JavaScript) or `subprocess`, or calls `os.system` (Python); a program that reads an environment variable that is neither credential-like nor bound. |
| SR-18 | The statement's `not_checked` shall always name: known vulnerabilities in dependencies; destinations and module paths computed at runtime; whether each reason is sufficient; behavior when running; that files under `test`, `tests`, `node_modules` and `.git` segments, and files named `*.test.*`, were not read; and that offering authority, external inputs and workspaces were not read (ROLES.md §34.2 item 5). It shall also name each shipped file in a language other than JavaScript or Python that looks like a program (`.sh`, `.rb`, `.go`, `.rs`, `.java`, `.php`), and each `dependencies[]` lockfile that is a shipped file not named `package-lock.json` or `npm-shrinkwrap.json`. |
| SR-19 | Every answer to a readable package shall carry the package digest. Changing one byte of a shipped file shall change it. Changing a file under `test/` shall not. |
| SR-20 | The same request shall produce a byte-identical answer on every run. |
| SR-21 | The reviewer shall call no model, open no network connection, and start no process. It shall run under Node's permission model with read-only file access. Its own package shall pass its own review with zero declared systems. |
| SR-22 | If a JavaScript program imports, re-exports or requires a module this review does not read, then the reviewer shall refuse with rule `unread-code`, with `system` set to the specifier as written, plus `file` and `line`. A specifier is its string's value, with escapes decoded. The review does not read: a relative specifier (`.`, `..`, `./` or `../`) that resolves, the way Node.js resolves it, to a path outside the package, to a file that is not a shipped file, or to no shipped file; an absolute path, or a URL other than `node:` or one SR-08 refuses; and a `#` subpath import, or the package's own name, that its `package.json` maps to such a module. Node.js resolves `import` as an ES module URL, and tries a name as written, then with an ending, then as a folder's `package.json` `main` and index. If a Python program imports, by `import`, `from` or `importlib.import_module` with a literal name, a module whose path, or whose path with a name a `from` imports, has a `test` or `tests` part after NFKC normalization, then the reviewer shall refuse the same way, with `system` set to that module path. A Python program is read as Python reads it: a byte order mark skipped, every line ending and line continuation, and each string form, f-string fields included. A Python program that declares a PEP 263 source encoding other than UTF-8 or ASCII, or names a module by a `\N{…}` escape, shall be refused the same way, with `system` set to `coding: ` and the encoding's name, or to the literal as written, since this review does not read it. Text that a string, template, regular expression or comment only contains is not an import. |
| SR-23 | If the package's `mcp.json` or `.mcp.json`, or the `mcpServers` of its `plugin.json` or `.claude-plugin/plugin.json`, names a server, as a key of that `mcpServers` object, that is not a system the descriptor declares, then the reviewer shall refuse with rule `undeclared-reach`, with `system` set to the server's name and `file` set to the file that names it. An `mcp.json` or `.mcp.json` that is not a JSON object, or whose `mcpServers` is absent or not an object, and a `plugin.json` whose `mcpServers` is present and not an object, such as a path or a bundle, shall be refused with rule `unreadable`, naming the file. |

## Program or judgment

| Step | How |
|---|---|
| Read the package | program |
| Find what the programs reach | program |
| Check the declaration and the owner's limits | program |
| Write the statement | program |
| Decide whether each reason is good enough | judgment, held by a person. Named in `not_checked`. The role requires a reason, not a good one. |

## Out of scope for 0.2.0

| Item | Why |
|---|---|
| Hosting on an AgentMesh fleet host (`run` block, job folder, signed manifest) | The host contract is not published in the files read. Needs the AgentMesh team. |
| Vulnerability lookups (OSV or similar) | Needs network; SR-21 forbids it. A separate step could hold it. |
| Python, Go or other lockfile formats | npm only, to keep the first slice small. Named in `not_checked` by SR-18. |

## Open questions

Each names its owner, and is decided at the next Test-stage reopen unless the owner decides
sooner.

1. The shape of a `dependencies[]` entry (`lockfile`, `sha256`) is this reviewer's reading of
   §12.4 item 2. The specification does not show one. Owner: spec owner.
2. Excluding `test/` from shipped files assumes the package maker does not ship tests. The
   built `incident-recorder/package` in CommonAgent/adlc supports this. Not confirmed, and the
   package maker's build is not run in CI. SR-22 refuses a program that imports an excluded
   file. Owner: AgentMesh team.
3. Whether reaching `localhost` should be treated like any other host. Treated the same here.
   Owner: spec owner.
4. Whether the published conformance check for ROLES.md §34.4, when one exists, agrees with the
   local harness in `conformance/`. None was published as of 2026-10-26. Owner: AgentMesh team.
5. SR-08 counts a URL used only as an identifier, such as a JSON Schema address, as reach. A
   trial run over CommonAgent/adlc at `fa174cf` refused `spec-writer` for its `SCHEMA_URL`.
   Whether identifiers should be exempt, and how to tell them apart without judgment, is open.
   Owner: spec owner.
6. The same trial run refused five of six lifecycle package sources for hard-coded hosts,
   including a model endpoint and a cloud metadata server. Whether the model the harness is
   given belongs in the derived set as a literal, or only by binding, needs the AgentMesh team.
   Owner: AgentMesh team.
7. The package digest is not the archive digest of Common Agent Specification §12.6 rule 5, so a
   statement cannot be joined to build or deployment records by digest. Whether the request
   should carry the archive digest for the answer to echo. Owner: AgentMesh team.
8. SR-22 reads `import`, `export … from`, `require` and `importlib.import_module` with a literal
   name. Other ways to load code, such as `require.call`, `require.apply`, `Reflect.apply`, an
   alias of `require`, `new Worker(…)`, `__import__`, `runpy` or a `.pth` file, are not read,
   and `not_checked` does not name them. Whether to add them, or name them. Owner: spec owner.
9. SR-23 checks that each MCP server is a declared system, by name. It does not check what a
   declared server runs or reaches: a `command` that runs an unshipped file, or a `url` to a host
   no system names, passes. Whether to read the server definitions, and against what, since a
   system declares no host. Owner: spec owner.
10. A symbolic link to a folder is not followed (Code stage choice U5), so files reached only
    through one, such as a `.claude-plugin` folder that is a link, are not read. Whether a
    folder link should make a package unreadable. Owner: spec owner.
