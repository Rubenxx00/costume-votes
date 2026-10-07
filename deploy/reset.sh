#!/usr/bin/env bash
#
# Reset the Costume Votes database.
#
# The schema is created with CREATE TABLE IF NOT EXISTS on every boot and the
# admin password is re-seeded from the env file whenever its settings row is
# missing (src/db.js, src/auth.js). So a reset is only ever removing data —
# there is nothing to re-initialise afterwards, and no migration step to run.
#
#   sudo ./deploy/reset.sh --all              wipe database + photos (default)
#   sudo ./deploy/reset.sh --keep-costumes    clear guests, votes and the voting
#                                             gate; keep costumes, photos, password
#   sudo ./deploy/reset.sh --password         restore the admin password from
#                                             $ENV_FILE (locked-out recovery)
#   sudo ./deploy/reset.sh --all --dry-run    print what would happen, touch nothing
#
# The data directory is backed up before anything destructive unless --no-backup
# is given. --yes skips the confirmation prompt (required when not on a tty).
set -euo pipefail

SERVICE="${SERVICE:-costume-votes}"
RUN_USER="${RUN_USER:-costume-votes}"
APP_DIR="${APP_DIR:-/opt/costume-votes}"
ENV_FILE="${ENV_FILE:-/etc/costume-votes.env}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
BACKUP_DIR="${BACKUP_DIR:-/root}"

MODE=all
DO_BACKUP=1
DRY_RUN=0
ASSUME_YES=0

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

usage() { sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^#\( \|$\)//'; }

while (( $# )); do
  case "$1" in
    --all|--everything)          MODE=all ;;
    --keep-costumes|--guests)    MODE=keep-costumes ;;
    --password|--password-only)  MODE=password ;;
    --no-backup)                 DO_BACKUP=0 ;;
    --dry-run)                   DRY_RUN=1 ;;
    -y|--yes)                    ASSUME_YES=1 ;;
    -h|--help)                   usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ------------------------------------------------------------- sanity checks
[[ $EUID -eq 0 ]] || die "run me with sudo"
command -v systemctl >/dev/null || die "systemd not found — this script needs it"
(( DRY_RUN )) || [[ -x "$NODE_BIN" ]] || die "$NODE_BIN not found (set NODE_BIN=...)"
systemctl cat "$SERVICE" >/dev/null 2>&1 || die "$SERVICE is not installed — see deploy/install.sh"

# DATA_DIR is authoritative in the env file; fall back to the install default.
DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DB="$DATA_DIR/party.db"
UPLOADS="$DATA_DIR/uploads"

[[ -d "$DATA_DIR" ]] || die "$DATA_DIR not found — is the app installed?"

# Run SQL as the service account rather than as root: the data directory is
# 750 <user>:<user>, and writing as root would leave root-owned -wal/-shm files
# the service can no longer write to.
as_user() {
  if   command -v runuser >/dev/null 2>&1; then runuser -u "$RUN_USER" -- "$@"
  elif command -v sudo    >/dev/null 2>&1; then sudo -u "$RUN_USER" -- "$@"
  else die "need runuser or sudo to act as $RUN_USER"
  fi
}

sql() {
  if (( DRY_RUN )); then printf '    [dry-run] sql: %s\n' "$1"; return 0; fi
  as_user "$NODE_BIN" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(process.argv[2]);
  ' "$DB" "$1" 2>&1 | grep -v -e ExperimentalWarning -e trace-warnings || true
}

if (( DRY_RUN )); then
  say "service=$SERVICE  data=$DATA_DIR  mode=$MODE  (dry run)"
else
  say "service=$SERVICE  data=$DATA_DIR  mode=$MODE"
fi
say "database=$DB"

# --------------------------------------------------------------- confirmation
if (( ! ASSUME_YES )) && [[ "$MODE" != password ]]; then
  [[ -t 0 ]] || die "refusing to reset without --yes when not on a terminal"
  echo
  case "$MODE" in
    all)           echo "  This DELETES the database and every uploaded photo." ;;
    keep-costumes) echo "  This DELETES all guests and votes (costumes and photos are kept)." ;;
  esac
  read -r -p "  Type 'reset' to continue: " answer
  [[ "$answer" == reset ]] || die "aborted — nothing changed"
fi

# ------------------------------------------------------------------ stop first
# Stopping before the backup is deliberate. It checkpoints the WAL into
# party.db, and it means the copy is not taken while the app is mid-write —
# a .db and a -wal captured at different instants can be a torn pair. This box
# is the cautionary example: party.db sat at 4 KB while party.db-wal held 2 MB,
# so a backup of party.db alone would have been an empty database.
say "stopping $SERVICE"
run systemctl stop "$SERVICE"

# --------------------------------------------------------------------- backup
if (( DO_BACKUP )); then
  BACKUP="$BACKUP_DIR/costume-votes-data-$(date +%Y%m%d-%H%M%S).tgz"
  say "backing up $DATA_DIR -> $BACKUP"
  run mkdir -p "$BACKUP_DIR"
  # Always the whole directory, never just the .db — see the note above.
  run tar czf "$BACKUP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
else
  warn "skipping the backup (--no-backup)"
fi

# --------------------------------------------------------------------- resets
case "$MODE" in
  all)
    # The WAL sidecars must go with the database: leaving them behind can replay
    # old frames into the database the app recreates on the next boot.
    say "removing database and photos"
    run rm -f "$DB" "$DB-wal" "$DB-shm"
    run rm -rf "$UPLOADS"
    ;;

  keep-costumes)
    say "clearing guests and votes"
    # votes cascade from guests, but delete both so the intent is explicit.
    sql "delete from votes; delete from guests;"
    # A test run probably opened voting; leaving ever_opened set would tell
    # arriving guests "closed by host" instead of "not opened yet".
    say "resetting the voting gate"
    sql "delete from settings where key in ('voting_open','voting_ever_opened','voting_closes_at');"
    ;;

  password)
    # checkPassword() re-reads this row on every login, so this could be done
    # live; we stopped anyway so the backup above is a clean checkpoint.
    say "clearing the stored admin password"
    sql "delete from settings where key = 'admin_password';"
    ;;
esac

# ------------------------------------------------------------------ start again
case "$MODE" in
  all)      say "starting $SERVICE (schema and admin password are recreated on boot)" ;;
  password) say "starting $SERVICE so \$ENV_FILE takes effect" ;;
  *)        say "starting $SERVICE" ;;
esac
run systemctl start "$SERVICE"

# ------------------------------------------------------------------ verify
if (( ! DRY_RUN )); then
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
    curl -sf "http://127.0.0.1:${PORT:-3000}/api/status" >/dev/null 2>&1 && break
    sleep 0.25
  done

  say "$SERVICE is active"
  printf '    status: %s\n' "$(curl -s "http://127.0.0.1:${PORT:-3000}/api/status" 2>/dev/null || echo 'unreachable')"

  if [[ "$MODE" == password ]]; then
    echo
    ADMIN_PW="$(sed -n 's/^ADMIN_PASSWORD=//p' "$ENV_FILE" | tail -1)"
    if [[ -n "$ADMIN_PW" ]]; then
      say "admin password is now the value in $ENV_FILE"
      echo "    read it with: sudo grep ADMIN_PASSWORD $ENV_FILE"
    else
      warn "ADMIN_PASSWORD is empty in $ENV_FILE — a random one was generated"
      echo "    it is printed once in: journalctl -u $SERVICE | grep -i 'password'"
    fi
    echo "    change it at:  Admin -> Settings -> Admin password"
    echo "    note: existing admin sessions stay valid — tick 'sign out other devices' in the UI."
  fi
fi

echo
say "done"
