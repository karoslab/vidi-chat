#!/usr/bin/env bash
#
# setup-new-user.sh — provision a fresh, independent vidi-chat instance for a
# NEW user on THEIR OWN Mac. Idempotent: safe to re-run.
#
# What it does, in order:
#   1. Check prerequisites (node >= 22.18, git, the claude CLI) and print
#      plain-language install pointers for anything missing.
#   2. Confirm the repo location (this script runs from inside the clone) and
#      resolve every path to an ABSOLUTE value for THIS user (no $HOME guesswork).
#   3. npm ci
#   4. Build with NEXT_DIST_DIR=.next-build (the production dist-dir contract).
#   5. Create the user's brain/wiki directory skeleton (config-driven name).
#   6. Write data/user-config.json (display name + agent-name-stack choice).
#   7. Generate + load the launchd plist from a template with ABSOLUTE paths
#      resolved at generation time (node bin, repo dir, logs dir, PATH,
#      VIDI_OWNER=1). Never relies on $HOME expansion inside the plist.
#   8. Print the success line: open http://127.0.0.1:4183
#
# It does NOT run `claude login` (an interactive GUI/browser step you run
# yourself — see Anthropic's Claude CLI docs) and does NOT mint any tokens
# (they self-mint at first boot, 0600).
#
# Hardware note: this is written to work on Intel x86_64 Macs (Homebrew/node
# under /usr/local) as well as Apple Silicon (/opt/homebrew). The node path and
# PATH entries are DETECTED at runtime — nothing is hardcoded to one arch.
#
# Flags:
#   --name "Display Name"     set the display name non-interactively
#   --brain-dir NAME          brain/wiki folder name (default derived from name)
#   --stack ID                agent name stack: scifi|movies|greek|kannada
#   --dry-run                 print every action + the generated plist/config,
#                             touch NOTHING (no install, no build, no write,
#                             no launchctl). Used to verify generation logic.
#   --non-interactive         never prompt; use flags/defaults
#   -h | --help               this help
#
set -euo pipefail

SERVICE_LABEL="com.vidi.vidichat"
PORT=4183
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
VALID_STACKS="scifi movies greek kannada"
DEFAULT_STACK="kannada"

DISPLAY_NAME=""
BRAIN_DIR=""
STACK=""
DRY_RUN=0
NON_INTERACTIVE=0

# ---------------------------------------------------------------------------
# tiny output helpers
# ---------------------------------------------------------------------------
step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
would() { printf '    \033[1;35m[dry-run]\033[0m would %s\n' "$*"; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------------------------------------------------------------------------
# args
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --name) DISPLAY_NAME="${2:-}"; shift 2 ;;
    --brain-dir) BRAIN_DIR="${2:-}"; shift 2 ;;
    --stack) STACK="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# resolve paths (absolute, for THIS user) — no $HOME guessing in outputs
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # <root>/vidi-chat
WORKSPACE_ROOT="$(cd "$REPO_DIR/.." && pwd)"       # <root> (brain sibling lives here)
USER_HOME="$HOME"
UID_NUM="$(id -u)"
ARCH="$(uname -m)"
PLIST_PATH="$USER_HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
LOG_DIR="$REPO_DIR/data/logs"                      # logs under the repo (data/ is 0700, gitignored)

step "vidi-chat new-user setup"
info "repo:            $REPO_DIR"
info "workspace root:  $WORKSPACE_ROOT"
info "home:            $USER_HOME"
info "arch:            $ARCH"
[ "$DRY_RUN" = "1" ] && warn "DRY RUN — no files written, nothing installed, no launchd changes"

# ===========================================================================
# 1. Prerequisites
# ===========================================================================
step "1/8  Checking prerequisites"

# --- node ---
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed.
    Install Node 22 LTS (supports macOS 12+, incl. Ventura, on Intel and Apple Silicon):
      • Easiest: download the macOS installer from https://nodejs.org (pick the LTS build).
      • Or with Homebrew:  brew install node@22
    Then re-run this script."
fi
NODE_BIN="$(command -v node)"
NODE_VER="$(node -v | sed 's/^v//')"           # e.g. 22.18.0
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"; NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node $NODE_VER is too old — this app needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (it runs TypeScript directly, which needs Node 22.18+).
    Install Node 22 LTS from https://nodejs.org and re-run."
fi
ok "node $NODE_VER at $NODE_BIN"

# --- git ---
if ! command -v git >/dev/null 2>&1; then
  die "git is not installed.
    Install Apple's Command Line Tools:  xcode-select --install
    (a dialog will pop up — click Install, wait for it to finish, then re-run this script)."
fi
ok "git $(git --version | awk '{print $3}')"

# --- claude CLI ---
CLAUDE_BIN=""
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
  ok "claude CLI at $CLAUDE_BIN"
else
  warn "the 'claude' CLI is NOT on PATH yet."
  info "Install it (Claude Code), then log in as THIS user later:"
  info "  npm install -g @anthropic-ai/claude-code    # or the current install method"
  info "  claude login                                # interactive, uses their Claude account"
  info "Setup will continue; the app can boot, but voice/chat turns need claude present + logged in."
fi

# ===========================================================================
# 2. Gather config (name + brain dir + stack)
# ===========================================================================
step "2/8  Instance identity"

prompt_if_needed() {
  # $1 = current value, $2 = prompt text, $3 = default → echoes chosen value
  local current="$1" prompt="$2" default="$3" answer=""
  if [ -n "$current" ]; then echo "$current"; return; fi
  if [ "$NON_INTERACTIVE" = "1" ] || [ "$DRY_RUN" = "1" ] || [ ! -t 0 ]; then echo "$default"; return; fi
  read -r -p "$prompt [$default]: " answer </dev/tty || answer=""
  echo "${answer:-$default}"
}

DISPLAY_NAME="$(prompt_if_needed "$DISPLAY_NAME" "Display name (how Vidi addresses the user)" "")"
# Derived defaults from the display name (a single lowercased token).
NAME_SLUG="$(printf '%s' "$DISPLAY_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
[ -z "$NAME_SLUG" ] && NAME_SLUG="user"
DEFAULT_BRAIN_DIR="$(printf '%s' "$DISPLAY_NAME" | tr -cd 'A-Za-z0-9')Wiki"   # e.g. MayaWiki
[ "$DEFAULT_BRAIN_DIR" = "Wiki" ] && DEFAULT_BRAIN_DIR="UserWiki"
BRAIN_DIR="$(prompt_if_needed "$BRAIN_DIR" "Brain/memory folder name (one plain folder, no slashes)" "$DEFAULT_BRAIN_DIR")"
USER_MODEL_FILE="${NAME_SLUG}-model.md"

# stack
if [ -z "$STACK" ]; then
  if [ "$NON_INTERACTIVE" = "1" ] || [ "$DRY_RUN" = "1" ] || [ ! -t 0 ]; then
    STACK="$DEFAULT_STACK"
  else
    echo "    Agent name stack (the pool Vidi's helper agents draw names from):"
    echo "      scifi   — Jarvis, HAL, Data, TARS, Cortana…"
    echo "      movies  — Neo, Ripley, Gandalf, Yoda…"
    echo "      greek   — Athena, Atlas, Hermes, Odin…"
    echo "      kannada — Garuda, Hanuma, Saraswati, Mithra… (default)"
    STACK="$(prompt_if_needed "" "Choose a stack" "$DEFAULT_STACK")"
  fi
fi
# validate stack (fail closed to the default on anything unrecognized)
case " $VALID_STACKS " in
  *" $STACK "*) : ;;
  *) warn "unknown stack '$STACK' — falling back to '$DEFAULT_STACK'"; STACK="$DEFAULT_STACK" ;;
esac
# validate brain dir is a single plain segment (mirrors lib/user-config.ts)
case "$BRAIN_DIR" in
  ""|"."|".."|*/*|*\\*) die "brain folder name must be a single plain folder (no slashes, not '.'/'..'): '$BRAIN_DIR'" ;;
esac

BRAIN_ROOT="$WORKSPACE_ROOT/$BRAIN_DIR"
info "display name:    $DISPLAY_NAME"
info "brain folder:    $BRAIN_ROOT"
info "user model file: $BRAIN_DIR/wiki/$USER_MODEL_FILE"
info "agent stack:     $STACK"

# ===========================================================================
# 3. npm ci
# ===========================================================================
step "3/8  Installing dependencies (npm ci)"
if [ "$DRY_RUN" = "1" ]; then
  would "run: (cd $REPO_DIR && npm ci)"
else
  info "This can take several minutes on an older Intel Mac — it is NOT stuck."
  ( cd "$REPO_DIR" && npm ci )
  ok "dependencies installed"
fi

# ===========================================================================
# 4. Build (NEXT_DIST_DIR=.next-build — the production dist-dir contract)
# ===========================================================================
step "4/8  Building the app (.next-build)"
if [ "$DRY_RUN" = "1" ]; then
  would "run: (cd $REPO_DIR && NEXT_DIST_DIR=.next-build npm run build)"
else
  info "Also several minutes on 2017-era Intel hardware — let it finish."
  ( cd "$REPO_DIR" && NEXT_DIST_DIR=.next-build npm run build )
  ok "build complete (.next-build)"
fi

# ===========================================================================
# 5. Brain / wiki skeleton
# ===========================================================================
step "5/8  Creating the brain folder skeleton"
BRAIN_SUBDIRS="wiki vidi/notes BRIEFINGS senses"
if [ "$DRY_RUN" = "1" ]; then
  for d in $BRAIN_SUBDIRS; do would "mkdir -p $BRAIN_ROOT/$d"; done
else
  for d in $BRAIN_SUBDIRS; do mkdir -p "$BRAIN_ROOT/$d"; done
  ok "brain skeleton at $BRAIN_ROOT (empty is fine — sections drop out when absent)"
fi

# ===========================================================================
# 6. data/user-config.json
# ===========================================================================
step "6/8  Writing data/user-config.json"
CONFIG_PATH="$REPO_DIR/data/user-config.json"
# Emit via node's JSON.stringify (node is a checked prereq) — a quote or
# backslash in --name would corrupt a naive heredoc into invalid JSON, which
# the app silently ignores, quietly reverting the identity to the defaults.
CONFIG_JSON=$(node -e '
  const [displayName, brainDirName, userModelFileName, agentNameStack] = process.argv.slice(1);
  process.stdout.write(
    JSON.stringify({ displayName, brainDirName, userModelFileName, agentNameStack }, null, 2)
  );
' "$DISPLAY_NAME" "$BRAIN_DIR" "$USER_MODEL_FILE" "$STACK")
if [ "$DRY_RUN" = "1" ]; then
  would "write $CONFIG_PATH:"
  printf '%s\n' "$CONFIG_JSON" | sed 's/^/        /'
else
  mkdir -p "$REPO_DIR/data"
  chmod 700 "$REPO_DIR/data" 2>/dev/null || true
  printf '%s\n' "$CONFIG_JSON" > "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH" 2>/dev/null || true
  ok "wrote $CONFIG_PATH"
fi

# ===========================================================================
# 7. launchd plist — ABSOLUTE paths resolved now (no $HOME expansion in plist)
# ===========================================================================
step "7/8  Generating the launchd plist"
NODE_DIR="$(dirname "$NODE_BIN")"
NEXT_BIN="$REPO_DIR/node_modules/next/dist/bin/next"

# Build PATH from DETECTED locations + the usual suspects. Works on Intel
# (/usr/local/bin) and Apple Silicon (/opt/homebrew/bin) — both are listed;
# a nonexistent dir in PATH is harmless. The claude bin dir is included so the
# app self-heals to `claude` on PATH even if VIDI_CLAUDE_BIN is unset.
PATH_ENTRIES="$NODE_DIR"
[ -n "$CLAUDE_BIN" ] && PATH_ENTRIES="$PATH_ENTRIES:$(dirname "$CLAUDE_BIN")"
PATH_ENTRIES="$PATH_ENTRIES:$USER_HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$USER_HOME/.local/bin"

# Optional: pin the detected claude bin so config resolution never guesses.
CLAUDE_ENV_BLOCK=""
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_ENV_BLOCK="		<key>VIDI_CLAUDE_BIN</key>
		<string>$CLAUDE_BIN</string>
"
fi

PLIST_CONTENT=$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$SERVICE_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$NEXT_BIN</string>
		<string>start</string>
		<string>-H</string>
		<string>127.0.0.1</string>
		<string>-p</string>
		<string>$PORT</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$PATH_ENTRIES</string>
		<key>HOME</key>
		<string>$USER_HOME</string>
		<key>NEXT_DIST_DIR</key>
		<string>.next-build</string>
		<key>VIDI_OWNER</key>
		<string>1</string>
$CLAUDE_ENV_BLOCK	</dict>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/vidichat.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/vidichat.error.log</string>
</dict>
</plist>
PLIST
)

if [ "$DRY_RUN" = "1" ]; then
  would "mkdir -p $LOG_DIR"
  would "write $PLIST_PATH:"
  printf '%s\n' "$PLIST_CONTENT" | sed 's/^/        /'
  would "launchctl bootout gui/$UID_NUM/$SERVICE_LABEL (ignore if not loaded)"
  would "launchctl bootstrap gui/$UID_NUM $PLIST_PATH"
  would "launchctl kickstart -k gui/$UID_NUM/$SERVICE_LABEL"
else
  mkdir -p "$LOG_DIR"
  mkdir -p "$USER_HOME/Library/LaunchAgents"
  printf '%s\n' "$PLIST_CONTENT" > "$PLIST_PATH"
  ok "wrote $PLIST_PATH"
  # Load (idempotent): bootout any existing instance, then bootstrap + kick.
  launchctl bootout "gui/$UID_NUM/$SERVICE_LABEL" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null; then
    ok "service bootstrapped"
  else
    # Fallback for environments where bootstrap is unavailable.
    launchctl load -w "$PLIST_PATH" 2>/dev/null || warn "could not load the service automatically — load it after 'claude login'"
  fi
  launchctl kickstart -k "gui/$UID_NUM/$SERVICE_LABEL" 2>/dev/null || true
  ok "service loaded ($SERVICE_LABEL)"
fi

# ===========================================================================
# 8. Done
# ===========================================================================
step "8/8  Done"
if [ "$DRY_RUN" = "1" ]; then
  info "Dry run complete — nothing was changed. Re-run without --dry-run to apply."
else
  echo ""
  echo "    Setup finished. Next:"
  echo "      1. Make sure the 'claude' CLI is installed and run:  claude login   (use their Claude account)"
  echo "      2. If the service was already running before login, restart it:"
  echo "           launchctl kickstart -k gui/$UID_NUM/$SERVICE_LABEL"
  echo ""
  echo "    Then open:  http://127.0.0.1:$PORT"
fi
