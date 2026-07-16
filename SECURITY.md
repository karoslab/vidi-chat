# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue for a
vulnerability.

- Use GitHub's private vulnerability reporting for this repository
  (Security tab, "Report a vulnerability"), or
- Email the maintainer at the address on the GitHub profile of the repository
  owner.

Include what you found, the version or commit, and the steps to reproduce.

We aim to acknowledge reports within a few days, but this is a personal project
maintained as time allows, so response may be slower.

There is no bug bounty and no paid reward program.

## Scope notes

- vidi-chat is local-first and binds loopback (`127.0.0.1`) by default. Treat
  any LAN/WAN exposure as out of scope for a stock install.
- The trust boundary is documented in [THREAT_MODEL.md](THREAT_MODEL.md). That
  document describes what is **mechanically** enforced today versus
  persona/journal soft rules.
- There are **no provider API keys in this app**. Backends use locally
  authenticated CLIs (Claude / Codex / Grok subscriptions). Compromise of those
  CLIs or of files the agent can read is outside this repo's control.
- `data/` (threads, tokens, journals) is gitignored and must never be committed.

If you find a way past a control that THREAT_MODEL.md claims is mechanical, that
is exactly the kind of report we want.
