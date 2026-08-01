#!/bin/sh
# Nyyon Command Center — one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/LevNyyon/nyyon-command-center/main/install.sh | sh
#
# Gets someone from a bare machine to the onboarding screen without them
# needing to know what Node, wrangler or D1 are. Deliberately POSIX sh, not
# bash: on a stock macOS the `sh` is always there and always the same, and this
# script has to run BEFORE we are allowed to assume any tooling exists.
#
# Design notes, because each of these is a real failure someone would hit:
#
#   * Node is installed through nvm, into the user's home directory. The
#     alternative (Homebrew, or a .pkg) needs sudo, and a password prompt in
#     the middle of a piped one-liner is where people give up. nvm needs no
#     admin rights and cannot break a system Node another project depends on.
#   * The download prefers `git clone`, because the whole point of this product
#     is that the operator can keep building on it with a coding agent, and
#     that is much better with version control. But git on a fresh Mac can
#     trigger the Xcode Command Line Tools dialog, which is a GUI prompt this
#     script cannot answer — so a tarball fallback keeps the install unattended.
#   * The server is started in the background and we poll the port rather than
#     sleeping a fixed number of seconds. First boot compiles the worker, which
#     takes wildly different times on different machines.
#
# Overrides, mainly so this can be tested before the repo is public:
#   NYYON_DIR    where to install          (default ~/nyyon-command-center)
#   NYYON_SRC    a local directory or git URL to install FROM
#   NYYON_REF    branch/tag                (default main)
#   NYYON_NO_START=1  set up but do not launch
set -eu

REPO_SLUG="${NYYON_REPO_SLUG:-LevNyyon/nyyon-command-center}"
REF="${NYYON_REF:-main}"
DIR="${NYYON_DIR:-$HOME/nyyon-command-center}"
SRC="${NYYON_SRC:-https://github.com/$REPO_SLUG.git}"
NODE_MAJOR_MIN=20
NODE_INSTALL_VERSION=22
WEB_PORT="${NYYON_WEB_PORT:-5180}"

# ── output ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B="$(printf '\033[1m')"; G="$(printf '\033[32m')"; R="$(printf '\033[31m')"
  Y="$(printf '\033[33m')"; D="$(printf '\033[2m')"; N="$(printf '\033[0m')"
else
  B=''; G=''; R=''; Y=''; D=''; N=''
fi
step() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%serror%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

printf '\n%sNyyon Command Center%s\n' "$B" "$N"
info "installing into $DIR"

# ── 1. platform ───────────────────────────────────────────────────────────
step "1. Checking your machine"
OS="$(uname -s)"
case "$OS" in
  Darwin) ok "macOS" ;;
  Linux)  ok "Linux" ;;
  *) die "unsupported system: $OS. This installs on macOS and Linux. On Windows, use WSL." ;;
esac

have curl || die "curl is required and was not found."

# ── 2. node ───────────────────────────────────────────────────────────────
# A too-old Node is worse than none: npm install half-succeeds and the failure
# surfaces later as a confusing module error, so the version is checked, not
# just the presence of the binary.
step "2. Node.js $NODE_MAJOR_MIN+"

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

need_node=1
if have node; then
  cur="$(node_major)"
  if [ -n "$cur" ] && [ "$cur" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null; then
    ok "found $(node -v)"
    need_node=0
  else
    warn "found $(node -v), which is older than v$NODE_MAJOR_MIN"
  fi
else
  info "not installed"
fi

if [ "$need_node" -eq 1 ]; then
  info "installing Node v$NODE_INSTALL_VERSION with nvm (no admin password needed)"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash >/dev/null 2>&1 \
      || die "could not install nvm. Install Node $NODE_MAJOR_MIN+ yourself from https://nodejs.org and re-run this."
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_INSTALL_VERSION" >/dev/null 2>&1 \
    || die "nvm could not install Node. Install Node $NODE_MAJOR_MIN+ from https://nodejs.org and re-run this."
  nvm use "$NODE_INSTALL_VERSION" >/dev/null 2>&1 || true
  have node || die "Node still is not on PATH after installing."
  ok "installed $(node -v)"
  NODE_VIA_NVM=1
else
  NODE_VIA_NVM=0
fi

have npm || die "npm is missing even though Node is present. Reinstall Node from https://nodejs.org."

# ── 3. the code ───────────────────────────────────────────────────────────
step "3. Getting the code"

if [ -e "$DIR" ]; then
  if [ -f "$DIR/workers/api/wrangler.jsonc" ]; then
    ok "already installed at $DIR, updating in place"
    EXISTING=1
  else
    die "$DIR already exists and is not a Nyyon install. Move it, or set NYYON_DIR to another path."
  fi
else
  EXISTING=0
  if [ -d "$SRC" ]; then
    # Local-directory source. Used for testing the installer before the repo is
    # public; also handy for installing from a checkout on the same machine.
    mkdir -p "$DIR"
    tar -C "$SRC" -cf - \
        --exclude .git --exclude node_modules --exclude .wrangler \
        --exclude dist --exclude desktop/out --exclude '.dev.vars*' . \
      | tar -C "$DIR" -xf - || die "could not copy from $SRC"
    ok "copied from $SRC"
  elif have git; then
    git clone --depth 1 --branch "$REF" "$SRC" "$DIR" >/dev/null 2>&1 \
      || die "could not clone $SRC (branch $REF). Is the repository public?"
    ok "cloned $REPO_SLUG"
  else
    # No git: tarball instead, so a fresh Mac does not stall on the Xcode
    # Command Line Tools dialog that `git` would pop up.
    info "git not found, downloading an archive instead"
    mkdir -p "$DIR"
    curl -fsSL "https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$REF" \
      | tar -xz -C "$DIR" --strip-components=1 \
      || die "could not download $REPO_SLUG. Is the repository public?"
    ok "downloaded $REPO_SLUG"
    warn "installed without git — install git later if you want version control"
  fi
fi

cd "$DIR" || die "could not enter $DIR"

# ── 4. setup ──────────────────────────────────────────────────────────────
# Everything hard (dependencies, the local database, migrations, seeds) already
# lives in scripts/setup.mjs and is idempotent. This installer's job is only to
# get a machine to the point where that script can run.
step "4. Setting it up"
info "installing dependencies and building the database, this takes a minute"
if npm run setup >/tmp/nyyon-setup.log 2>&1; then
  ok "ready"
else
  printf '\n'; tail -25 /tmp/nyyon-setup.log
  die "setup failed. The full log is at /tmp/nyyon-setup.log"
fi

# ── 5. the desktop app ────────────────────────────────────────────────────
# This is the deliverable: a real application with its own window and a Dock
# icon, NOT a browser tab pointed at localhost. The app shell starts the worker
# and the interface as its own child processes, so there is no dev server for
# the operator to babysit and nothing to keep a terminal open for.
#
# Building here rather than shipping a prebuilt binary has a large side
# benefit: macOS only quarantines files that were DOWNLOADED. An app compiled
# on the machine it runs on is not quarantined, so Gatekeeper does not block
# it and this needs no Apple Developer signing or notarization.
step "5. Building the app"
if [ "$OS" = "Darwin" ]; then
  info "packaging Nyyon Command Center, this is the slow part"
  if npm run package >/tmp/nyyon-package.log 2>&1; then
    ok "built"
  else
    printf '\n'; tail -20 /tmp/nyyon-package.log
    die "could not build the desktop app. Log: /tmp/nyyon-package.log"
  fi

  APP="$(find "$DIR/desktop/out" -maxdepth 2 -name 'Nyyon Command Center.app' -print 2>/dev/null | head -1)"
  [ -n "$APP" ] || die "the app was built but could not be found under $DIR/desktop/out"

  # A symlink, not a copy. The bundle locates its own source by walking up from
  # its binary, so a COPY sitting in /Applications would be an app that cannot
  # find the code it is supposed to run. Linking keeps one real bundle inside
  # the checkout while still giving Spotlight and Launchpad something to find.
  if [ -w /Applications ]; then
    rm -f "/Applications/Nyyon Command Center.app" 2>/dev/null || true
    if ln -s "$APP" "/Applications/Nyyon Command Center.app" 2>/dev/null; then
      ok "added to Applications"
    fi
  fi
else
  warn "desktop packaging is macOS-only for now; this install runs in a browser"
fi

if [ "${NYYON_NO_START:-0}" = "1" ]; then
  step "Done"
  [ "$OS" = "Darwin" ] && info "open it from Applications, or: open \"$APP\""
  exit 0
fi

# ── 6. launch ─────────────────────────────────────────────────────────────
step "6. Opening"
if [ "$OS" = "Darwin" ]; then
  open "$APP" || die "could not launch the app. Open it from Applications."
  ok "Nyyon Command Center is starting"
  step "You're in"
  info "The app is opening now. It shows a progress bar while it warms up,"
  info "then asks you to create your account and connect a model key."
  info "It is in your Dock — right-click and Keep in Dock to pin it."
else
  # Linux has no packaged bundle yet, so fall back to the servers + browser.
  if curl -fsS -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; then
    die "something is already running on port $WEB_PORT. Stop it, or use NYYON_WEB_PORT."
  fi
  npm start >/tmp/nyyon-run.log 2>&1 &
  SERVER_PID=$!
  i=0
  until curl -fsS -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -gt 120 ] && { tail -25 /tmp/nyyon-run.log; die "did not come up. Log: /tmp/nyyon-run.log"; }
    kill -0 "$SERVER_PID" 2>/dev/null || { tail -25 /tmp/nyyon-run.log; die "server stopped. Log: /tmp/nyyon-run.log"; }
    sleep 1
  done
  have xdg-open && xdg-open "http://localhost:$WEB_PORT" >/dev/null 2>&1 || true
  ok "running at http://localhost:$WEB_PORT"
fi

if [ "$EXISTING" = "0" ]; then
  printf '\n'; info "The code is at $DIR — that folder IS the app. Edit it and reopen."
fi
if [ "$NODE_VIA_NVM" = "1" ]; then
  warn "Node was installed via nvm, into your home directory."
fi
printf '\n'

# On macOS the app is its own process and this script is done. On Linux the
# servers are ours, so stay attached to them.
[ "$OS" = "Darwin" ] || wait "$SERVER_PID"
