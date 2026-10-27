# Security policy

This repository holds a security reviewer for AI agent packages. A way past it is a
vulnerability: a package the reviewer passes, though a program in it reaches a system, reads
a credential or loads code the package does not declare, or an answer that repeats a
credential.

## Report it privately

Use GitHub's private reporting: the repository's **Security** tab, then **Report a
vulnerability**. Do not open a public issue or pull request for it.

Include:

- the smallest package, or program, that the reviewer gets wrong;
- the request you ran and the answer you got;
- what the program does when it runs;
- the commit you tested.

## Already known

The gaps listed under [What a pass does not cover](README.md#what-a-pass-does-not-cover) are
known and need no report.
