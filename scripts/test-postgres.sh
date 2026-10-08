#!/bin/sh
# A throwaway Postgres cluster for the test suite, started without sudo, without
# a system service and without a permission prompt.
#
# ---------------------------------------------------------------------------
# Why this exists
# ---------------------------------------------------------------------------
#
# A Factory worker, a Cowork Routine or a developer running the Postgres half of
# `npm run test:impacted` used to reach for `sudo -u postgres psql`,
# `pg_ctlcluster`, `systemctl start postgresql` and an inline `DO $$ … $$`
# block. Every one of those is a privileged, compound command, so an unattended
# session stopped at a permission prompt nobody was there to answer — and the
# only way to pre-approve them would have been to allow arbitrary `sudo` and
# arbitrary compound Bash, which is the one thing `.claude/settings.json`
# refuses to do.
#
# So the whole of it is one reviewed script, and `.claude/settings.json`
# pre-approves exactly this path. What it does is narrow by construction:
#
#   * one cluster, in one directory under the system temp directory, owned by
#     whoever runs it (or by the `postgres` account when the caller is root,
#     because initdb refuses root);
#   * listening on 127.0.0.1 and a socket inside that directory only — never a
#     public address, never the system cluster;
#   * trust authentication for that loopback address only, which is safe for
#     the same reason a CI service container is: nothing but this machine can
#     reach it and it holds nothing but test schemas;
#   * one role, `brain_test`, LOGIN CREATEDB — never SUPERUSER — which is the
#     same privilege postgres-suite.yml grants, because the suite creates and
#     drops its own schemas and needs no more than that;
#   * the lock table sized as postgres-suite.yml sizes it, for its reason.
#
# It touches no credential, no production URL and nothing outside its own
# directory, and `down` removes that directory.
#
#   scripts/test-postgres.sh up        start (idempotent) and print the URL
#   scripts/test-postgres.sh url       print the URL of a running cluster
#   scripts/test-postgres.sh down      stop and remove it
#   scripts/test-postgres.sh run -- <command…>
#                                      up, run the command with
#                                      BRAIN_TEST_DATABASE_URL set, and keep the
#                                      cluster for the next run
set -eu

PORT="${BRAIN_TEST_PG_PORT:-54329}"
BASE="${TMPDIR:-/tmp}/brain-test-pg-$PORT"
DATA="$BASE/data"
SOCK="$BASE/sock"
LOG="$BASE/postgres.log"
ROLE=brain_test
DB=brain_test
URL="postgresql://$ROLE@127.0.0.1:$PORT/$DB?sslmode=disable"

case "$PORT" in
  ''|*[!0-9]*) echo "test-postgres: BRAIN_TEST_PG_PORT must be a number" >&2; exit 2 ;;
esac

bindir() {
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  for candidate in /usr/lib/postgresql/*/bin; do
    if [ -x "$candidate/pg_ctl" ]; then latest="$candidate"; fi
  done
  if [ -n "${latest:-}" ]; then echo "$latest"; return; fi
  echo "test-postgres: no PostgreSQL server binaries found (install postgresql)" >&2
  exit 3
}

BIN="$(bindir)"

# initdb and postgres refuse to run as root. The `postgres` account the package
# creates is the least-privileged owner available, and the directory is the only
# thing it is given.
as_owner() {
  if [ "$(id -u)" = "0" ]; then
    if ! id postgres >/dev/null 2>&1; then
      echo "test-postgres: running as root and there is no postgres account to own the cluster" >&2
      exit 3
    fi
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

running() {
  as_owner "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1
}

up() {
  mkdir -p "$BASE"
  if [ "$(id -u)" = "0" ]; then chown postgres "$BASE"; fi
  if [ ! -f "$DATA/PG_VERSION" ]; then
    as_owner mkdir -p "$DATA" "$SOCK"
    as_owner "$BIN/initdb" -D "$DATA" -U postgres --auth-local=trust --auth-host=reject \
      --no-instructions >/dev/null
    # Loopback only, trust only for loopback; everything else rejected above.
    as_owner sh -c "printf '%s\n' \
      'local all all trust' \
      'host all all 127.0.0.1/32 trust' > '$DATA/pg_hba.conf'"
    as_owner sh -c "printf '%s\n' \
      \"listen_addresses = '127.0.0.1'\" \
      \"port = $PORT\" \
      \"unix_socket_directories = '$SOCK'\" \
      'max_locks_per_transaction = 1024' \
      'fsync = off' \
      'synchronous_commit = off' >> '$DATA/postgresql.conf'"
  fi
  if ! running; then
    as_owner "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w -t 60 start >/dev/null
  fi
  psql_admin() { as_owner "$BIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -tAq "$@"; }
  if [ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'")" != "1" ]; then
    psql_admin -c "CREATE ROLE $ROLE LOGIN CREATEDB" >/dev/null
  fi
  if [ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")" != "1" ]; then
    as_owner "$BIN/createdb" -h "$SOCK" -p "$PORT" -U postgres -O "$ROLE" "$DB"
  fi
  echo "BRAIN_TEST_DATABASE_URL=$URL"
}

down() {
  if [ -f "$DATA/PG_VERSION" ] && running; then
    as_owner "$BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null
  fi
  rm -rf "$BASE"
  echo "test-postgres: stopped and removed $BASE"
}

command="${1:-}"
case "$command" in
  up) up ;;
  url)
    if running; then echo "BRAIN_TEST_DATABASE_URL=$URL"; else echo "test-postgres: not running" >&2; exit 1; fi
    ;;
  down) down ;;
  run)
    shift
    if [ "${1:-}" = "--" ]; then shift; fi
    if [ "$#" -eq 0 ]; then echo "test-postgres: run needs a command after --" >&2; exit 2; fi
    up >/dev/null
    BRAIN_TEST_DATABASE_URL="$URL" exec "$@"
    ;;
  *)
    echo "usage: scripts/test-postgres.sh up | url | down | run -- <command…>" >&2
    exit 2
    ;;
esac
