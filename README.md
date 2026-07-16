# vidi-chat

A personal chatbox. You talk to **Vidi** — an assistant persona — who answers
questions about you, your projects, and your ops stack by actually reading the
files on your own machine.

Sister app to the macOS voice companion ([karoslab/vidi](https://github.com/karoslab/vidi)). This is the text/agent side.

## The whole point: subscriptions, not API keys

There are **no API keys anywhere in this app**. The backend spawns
locally-authenticated CLIs and streams their output:

- **Claude Max** — spawns the `claude` CLI (Claude Code) in non-interactive
  print mode. Billed to the Claude Max subscription already logged in on this
  Mac.
- **Codex (ChatGPT)** — spawns OpenAI's `codex` CLI (`codex exec --json`),
  billed to the ChatGPT subscription (`codex login`).
- **Grok (xAI)** — spawns xAI's `grok` CLI headlessly
  (`grok -p --output-format streaming-json --sandbox strict`), billed to the
  Grok subscription (`grok login`). Always read-only (kernel sandbox + a
  read-tool allowlist; see the Grok confinement notes below). Model: Grok 4.5
  only. Grok's coding models (e.g. Composer 2.5) run under a different grok
  agent whose tool profile is outside this confinement audit, so they are not
  offered.

## Run it

```bash
npm install
npm run dev        # http://localhost:4183
```

## Model policy (token discipline)

Two tiers, shipped as the DEFAULT for every install (`lib/model-policy.ts` +
the router in `lib/models.ts`):

- **Deep tier** — planning (Plan mode), build-shaped delegations, standing-goal
  ticks, and any high+ effort turn. Claude → **opus** at **high** effort. Fable
  is retired; nothing routes to it (an old `fable` pin degrades to opus).
- **Worker tier** — every spawned fleet/background agent that isn't flagged
  build-shaped. Claude → **sonnet**, codex → the cheapest catalog slug
  (**gpt-5.5**), at **medium** effort.

An explicit or thread-pinned model/effort always wins over the tier default.
The dial: planning/review reasons at "high" by default; mechanical work stays
"medium" (never the burn-prone "max" on shallow asks). A claude-only install is
fully served by the claude fields — codex/grok are optional.

Override per install without touching source (env beats
`data/user-config.json`'s `modelPolicy` key, beats the default; an unrecognized
value is silently dropped):

```bash
VIDI_WORKER_MODEL=sonnet        # claude worker tier (auto|opus|sonnet)
VIDI_WORKER_CODEX_MODEL=gpt-5.5 # codex worker tier (default|gpt-5.5|gpt-5.6-*)
VIDI_WORKER_EFFORT=medium       # low|medium|high|xhigh|max|ultra
VIDI_DEEP_EFFORT=high           # effort for the deep/opus tier
VIDI_DEEP_MODEL=auto            # deep delegation model (auto → router picks opus)
```

In-CLI Task subagents (reachable only on a deep/ultracode turn) can't be pinned
to a model via any CLI flag from here, so their discipline is enforced at the
persona level: the ultracode system prompt tells the turn to keep routine
sub-work on a Sonnet-class subagent.

## How the Claude backend works

Each chat turn spawns (verified against claude CLI 2.1.195):

```bash
claude -p "<message>" \
  --output-format stream-json --include-partial-messages --verbose \
  --append-system-prompt-file VIDI_PERSONA.md \
  --allowedTools "Read,Grep,Glob" \
  --disallowedTools "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task" \
  --add-dir "$HOME" \
  --model sonnet            # or opus
  # follow-up turns add: --resume <session_id>
```

- `VIDI_PERSONA.md` (repo root) is the product: Vidi's voice, her evidence-only
  rule, and the knowledge manifest telling her where to look (Claude's memory
  dir, your notes/brain dir, every project's README/AGENTS/CLAUDE.md, ops
  conventions). It's
  passed via `--append-system-prompt` (with mode/voice addenda appended).
- In chat mode tools are **read-only** (Read/Grep/Glob), so Vidi can consult
  files but never write or execute anything.
- The adapter parses the stream-json events: `session_id` from the `init`
  event, `text_delta` chunks forwarded live over SSE, `tool_use` blocks from
  `assistant` events (for the journal), final text from the `result` event.
  The `session_id` is stored per thread and passed back via `--resume` for
  conversation continuity.

## Act mode — the trust dial

Each thread is either **Chat** (read-only, the default) or **Act** — flipped
with the segmented toggle in the sidebar, persisted on the thread, shown as an
amber `act` badge. Act mode is Claude-only. In act mode the spawn becomes:

```bash
claude -p "<message>" … \
  --setting-sources project \
  --strict-mcp-config \
  --allowedTools "Read,Grep,Glob,Edit,Write,Skill,Bash(git *),Bash(gh *),Bash(npm *),Bash(npx *),Bash(bun *),Bash(ls *),Bash(mkdir *),Bash(mv *),Bash(cp *),…,Bash(vidi-act *)" \
  --disallowedTools "NotebookEdit,WebFetch,WebSearch,Task,Read(~/.ssh/**),Read(**/.dev.vars),Read(**/.env*),…(same for Edit/Write); raw Bash(node *)/Bash(python3 *) are NOT allowed" \
  --add-dir "$WORKSPACE_ROOT"
```

What each layer buys (verified against claude 2.1.195 — the allowlist and
denylist flags shown above are the enforcement mechanism, every act-mode tool
call is journaled to `data/journal.jsonl` so the behavior is auditable after the
fact, and the injection-fence coverage is documented in
`docs/INJECTION-FENCES.md`):

- **Mechanically enforced:** Bash restricted to the safe prefix allowlist
  (anything else auto-denies headless); Edit/Write jailed to the workspace
  root; direct Read/Edit/Write of the secret paths denied; no MCP servers; no
  web/subagent tools. `--setting-sources project` is what makes all of this
  real — without it the user-level settings blanket-allow everything.
- **Persona-enforced only (honest gaps):** the confirm tier — destructive or
  outward actions (deletes outside a repo, force-push, deploys, anything sent
  off this machine) require Vidi to state the action and get an explicit "yes"
  in the next message; and residual interpreter escape via allowlisted
  `npm`/`npx`/`bun` scripts. Raw `node`/`python3` are not on the allowlist.
  The journal exists so you can audit exactly what she ran.

Every act-mode tool call is journaled to `data/journal.jsonl`
(`{ts, threadId, tool, summary}`) — the **Journal** button in the header shows
the latest 50, and Vidi herself reads the file back when you ask "what did you
do".

## Voice command endpoint

Fixed contract for the menu-bar app:

```
POST /api/voice-command  {"transcript": "..."}
→ SSE:  data: {"type":"ack"}
        data: {"type":"delta","text":"..."}   (zero or more)
        data: {"type":"result","text":"<complete answer>"}
```

Runs an act-mode turn on one persistent thread titled `voice` (created on
first use, resumed thereafter), with extra system text telling Vidi the reply
will be spoken aloud (1-3 short sentences, no markdown). Errors are folded
into the `result` text — the consumer always gets those three event types and
nothing else. After the result, an optional fire-and-forget Discord ping can be
sent ("Vidi did: …", non-fatal on error) if a notifier is configured.

Push notifications go through `lib/push.ts`. The default transport is **ntfy**
(self-contained: it posts to ntfy.sh and self-mints a local topic under
`data/ntfy-topic`, so push works without any other install). An optional
Discord (or other) fallback can shell out to a notify script you supply via
`setNotifyScriptPath()` / `registerTransport()`; that path is fail-open and is
not required for core chat. Note: ntfy.sh sees notification titles/bodies —
treat the topic file as a secret.

The Codex adapter mirrors this with `codex exec --json -s read-only` and
`codex exec resume <thread_id>` for continuity. Codex has no system-prompt
flag, so the persona is prepended to the first message of each thread. Note:
codex's `--json` mode delivers the reply as one chunk (no token streaming).

The Grok adapter uses `grok -p --output-format streaming-json` (real token
deltas via `{type:"text"}`) and `-r <sessionId>` (the `end` event's id) for
continuity. Persona is prepended like codex. Grok headless reports no token
counts, so the quota ledger records the turn without token fields.

Grok is confined by three independent controls (an earlier `--sandbox read-only`
+ single `run_terminal_cmd` deny was proven insufficient by a live audit):

- **Write boundary (kernel).** `--sandbox strict` (Seatbelt) run with `--cwd`
  set to an empty throwaway jail dir under the OS temp dir, outside the
  workspace. strict writes only to its CWD plus `~/.grok/` and temp, so the
  workspace and home are not writable. A workspace write fails with `os error 1`.
  This does not rely on grok's own permission prompt (which this box defaults to
  "always-approve").
- **Read boundary (tool scope, backed by the kernel where it reaches).** The
  honest picture, verified live from `~/.grok/sandbox-events.jsonl`
  (`ProfileApplied`, macos/seatbelt, `enforced:true`): the `strict` kernel profile
  denies the `$HOME` root, the workspace, `~/.ssh`, `~/.aws`, and `~/.codex`, but
  it GRANTS `~/.grok` read-write and `~/Library` read-only at the kernel. So the
  sandbox alone does not protect grok's own live credential (`~/.grok/auth.json`,
  which holds the refresh token and access JWT) or `~/Library/Keychains` — a
  strict-sandboxed grok that still had a read tool could read them. The real read
  boundary is therefore the **tool allowlist**: grok is given no `read_file` or
  `list_dir` at all, so it has no way to open any file, including the
  kernel-readable `~/.grok` and `~/Library` paths. The kernel strict profile still
  adds defense in depth for the paths it does deny (workspace, `$HOME` root,
  `~/.ssh`/`~/.aws`/`~/.codex`), and `strict` is a built-in profile a user config
  cannot redefine. Trade-off: grok also loses legitimate workspace reads, which is
  acceptable for a read-only chat brain (the persona is injected in-process, not
  read by grok).
- **Egress (tool scope, not the sandbox).** There is no kernel network boundary
  for grok on macOS: `restrict_network` is a documented Linux-only no-op there,
  and in-process HTTP tools are never blocked by it on any platform. Egress is
  closed with the `--tools todo_write` allowlist — one harmless in-session
  task-list tool that is neither filesystem nor network (an empty `--tools ""` is
  NOT usable: grok reads it as "use the default toolset", which re-enables
  `read_file` and leaks the token — verified live). With only that one tool, no
  web, shell, monitor, subagent, scheduler or image tool exists to reach the
  network, and no read tool exists to reach a secret. It is backed by a
  `--disallowed-tools` denylist of every egress and escalation tool plus
  `--disable-web-search` and `--no-subagents`. Verified live: reads of
  `~/.grok/auth.json` and `~/Library/Keychains` return nothing, an ipify fetch
  returns no IP, and a read-then-POST exfil attempt fails.

Residual risk: grok's own turn reaches xAI's backend in-process, so content grok
legitimately handles reaches xAI. That is THREAT_MODEL B5 accepted risk. The B5
non-accepted case, secrets POSTed to an attacker endpoint, is closed by the read
and egress controls above.

## Storage

Plain JSON files in `data/threads/<id>.json` (gitignored). No database. Each
thread stores `{id, title, provider, model, mode, providerSessionId,
messages[]}`. The act-mode action journal is `data/journal.jsonl`.

## Adding a provider

1. Create `lib/providers/<name>.ts` implementing `BrainProvider` from
   `lib/providers/types.ts`: an `available()` check and a `sendMessage()`
   async generator yielding `{type:"delta"|"done"|"error"}` events.
2. Register it in `lib/providers/index.ts`.
3. Add it to the provider dropdown in `components/Chat.tsx`.

The rule of the house: the provider must run on a **local subscription-authed
CLI**, never an API key.

## API

- `POST /api/chat` `{threadId?, message, provider?, model?, mode?}` → SSE stream
  (`meta`, `delta`, `tool`, `done`/`error` events)
- `GET /api/threads` / `POST /api/threads` — list / create
- `GET /api/threads/:id` / `DELETE /api/threads/:id` — fetch / delete
- `PATCH /api/threads/:id` `{mode}` — flip a thread between chat and act
- `GET /api/providers` — availability + models (drives the UI dropdown)
- `GET /api/journal` — latest 50 act-mode journal entries, newest first
- `POST /api/voice-command` `{transcript}` → SSE `ack`/`delta`/`result` (above)


## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [THREAT_MODEL.md](THREAT_MODEL.md)
