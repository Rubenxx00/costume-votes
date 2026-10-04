#!/usr/bin/env bash
#
# Install Costume Votes as a systemd service.
#
# This exists because the manual steps in ORACLE.md failed in two ways that were
# invisible until the service was started: the unit hardcoded `User=ubuntu`
# (present only on Ubuntu images -> systemd status=217/USER everywhere else),
# and its sandbox omitted AF_NETLINK, which killed the app on boot. Doing the
# wiring here means both are handled once, on every distro.
#
#   sudo ./deploy/install.sh                 # install from this checkout
#   sudo ./deploy/install.sh --from-git      # clone from GitHub instead
#
# Idempotent: re-running upgrades the code and restarts the service, and it
# never regenerates or prints the admin password once one is configured.
set -euo pipefail

SERVICE=costume-votes
RUN_USER=costume-votes
APP_DIR=/opt/costume-votes
ENV_FILE=/etc/costume-votes.env
UNIT=/etc/systemd/system/${SERVICE}.service
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
REPO_URL="${REPO_URL:-https://github.com/Rubenxx00/costume-votes.git}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run me with sudo"
command -v systemctl >/dev/null || die "systemd not found — this installer needs it"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_GIT=0
[[ "${1:-}" == "--from-git" ]] && FROM_GIT=1

# ---------------------------------------------------------------- node check
if [[ ! -x "$NODE_BIN" ]]; then
  die "$NODE_BIN not found. Install Node >= 22.5 first, e.g.
       curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
       curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs
     or pass NODE_BIN=/path/to/node"
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$("$NODE_BIN" -p 'process.versions.node.split(".").map(Number)[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  die "Node $("$NODE_BIN" -v) is too old — the app needs >= 22.5 for node:sqlite"
fi
say "using Node $("$NODE_BIN" -v) at $NODE_BIN"

# --------------------------------------------------------------- service user
# A dedicated system account rather than whichever login user happened to run
# this: the app needs no shell, no home, and no more privilege than its own
# database directory.
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  say "creating system user $RUN_USER"
  useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$RUN_USER"
else
  say "system user $RUN_USER already exists"
fi

# ------------------------------------------------------------------ app files
if (( FROM_GIT )); then
  command -v git >/dev/null || die "git not found"
  if [[ -d "$APP_DIR/.git" ]]; then
    say "updating $APP_DIR from $REPO_URL"
    git -C "$APP_DIR" fetch --quiet origin
    git -C "$APP_DIR" reset --hard --quiet origin/HEAD
  else
    say "cloning $REPO_URL -> $APP_DIR"
    mkdir -p "$APP_DIR"
    git clone --quiet "$REPO_URL" "$APP_DIR"
  fi
else
  [[ -f "$SRC_DIR/package.json" ]] || die "$SRC_DIR does not look like the repo"
  say "syncing code from $SRC_DIR -> $APP_DIR"
  mkdir -p "$APP_DIR"
  # Start from the repo contents, but never touch data/ or .git.
  tar -C "$SRC_DIR" --exclude=./data --exclude=./node_modules --exclude=./.git -cf - . \
    | tar -C "$APP_DIR" -xf -
fi

chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

say "installing dependencies"
( cd "$APP_DIR" && npm ci --omit=dev --silent ) || die "npm ci failed"

# The only path the service may write to.
install -d -o "$RUN_USER" -g "$RUN_USER" -m 750 "$APP_DIR/data"

# --------------------------------------------------------------- environment
if [[ -f "$ENV_FILE" ]]; then
  say "$ENV_FILE already exists — leaving it alone"
  chmod 600 "$ENV_FILE"
  ADMIN_PW=""
else
  ADMIN_PW="$(openssl rand -base64 24)"
  say "writing $ENV_FILE"
  install -m 600 -o root -g root "$SRC_DIR/deploy/costume-votes.env.example" "$ENV_FILE"
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PW}|" "$ENV_FILE"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=${APP_DIR}/data|" "$ENV_FILE"
  # Replaced with the tunnel hostname once it is known (see ORACLE.md §3).
  sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=|" "$ENV_FILE"
fi

# --------------------------------------------------------------------- unit
say "installing $UNIT"
install -m 644 -o root -g root "$SRC_DIR/deploy/costume-votes.service" "$UNIT"
# The packaged ExecStart assumes /usr/bin/node; honour NODE_BIN if it differs.
if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
  sed -i "s|^ExecStart=.*|ExecStart=${NODE_BIN} src/server.js|" "$UNIT"
fi

systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"

# --------------------------------------------------------------- verify boot
# Failing here with the real reason beats leaving a restart-looping unit and a
# "why is nothing on :3000" later.
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$SERVICE" && break
  sleep 0.25
done
if ! systemctl is-active --quiet "$SERVICE"; then
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  die "$SERVICE failed to start (see the log above)"
fi

PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:${PORT:-3000}/api/status" >/dev/null && break
  sleep 0.25
done

say "$SERVICE is active"
journalctl -u "$SERVICE" -n 12 --no-pager | grep -E 'running|Guests|Admin|Public|Voting' || true

echo
if [[ -n "$ADMIN_PW" ]]; then
  echo "  ┌──────────────────────────────────────────────────┐"
  echo "  │  ADMIN PASSWORD (shown once — store it now)      │"
  printf "  │  %-46s │\n" "$ADMIN_PW"
  echo "  └──────────────────────────────────────────────────┘"
  echo "  Change it any time at Admin → Settings → Admin password."
else
  echo "  Admin password unchanged (${ENV_FILE} was already present)."
  echo "  Forgot it? Change it at Admin → Settings → Admin password."
fi
echo
echo "  Next: set up the tunnel — see deploy/ORACLE.md §3."
echo
