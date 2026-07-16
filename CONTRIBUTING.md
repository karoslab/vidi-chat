# Contributing to vidi-chat

Thanks for helping. This is a personal project maintained as time allows, so
reviews may be slow. Small, focused changes land fastest.

## Setup

```bash
npm install
npm test                 # node:test suite — must stay green
npm run dev              # http://127.0.0.1:4183
```

Requires Node `>=22.18` and (for chat) a locally logged-in `claude` CLI (or
codex/grok if you enable those providers).

Optional first-run helper for a clean Mac user:

```bash
./scripts/setup-new-user.sh --help
```

## Ground rules

- **No API keys in-process.** Providers spawn local subscription-authenticated
  CLIs. Do not add hosted-key providers without an explicit design change.
- **Keep the threat model honest.** If you change allow/deny tools, path jails,
  or auth gates, update [THREAT_MODEL.md](THREAT_MODEL.md) in the same PR.
- **Tests for security-sensitive paths.** Auth gates, secret paths, write jail,
  and injection fences need unit coverage.
- **Default bind stays loopback.** Do not change `127.0.0.1` binds casually.

## Sending a change

1. Fork and branch from `main`.
2. `npm test` green.
3. Open a PR with what changed, why, and any threat-model impact.
