#!/usr/bin/env bash
# Proves a backup can be restored, using a temporary database that is removed afterwards.
# Usage: ./deploy/restore-test.sh [backup file]   (default: the newest backup)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DIR="${LLMR_BACKUP_DIR:-backups}"
FILE="${1:-$(ls -1t "$DIR"/llm-rudder-*.backup 2>/dev/null | head -n 1)}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "No backup found." >&2; exit 1; }

umask 077
WORK="$(mktemp -d)"
NAME="llm-rudder-restore-test-$$"
PASSWORD="$(openssl rand -hex 16)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker compose run --rm -T --no-deps gateway node dist/cli.js backup-open <"$FILE" | gzip -dc | tar -C "$WORK" -xf -
for item in database.sql env config.yaml; do
  [ -s "$WORK/$item" ] || { echo "The backup has no $item." >&2; exit 1; }
done

docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD="$PASSWORD" -e MYSQL_DATABASE=llm_rudder \
  --tmpfs /var/lib/mysql mysql:8.4 >/dev/null
sql() { docker exec -i -e MYSQL_PWD="$PASSWORD" "$NAME" mysql -N -uroot llm_rudder "$@"; }
for _ in $(seq 1 120); do
  sql -e 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
sql <"$WORK/database.sql"

for table in requests attempts usage_daily client_keys spend quota_state __drizzle_migrations; do
  sql -e "SELECT COUNT(*) FROM \`$table\`" >/dev/null || { echo "Table $table is missing." >&2; exit 1; }
done
echo "Restored $(basename "$FILE"): $(sql -e 'SELECT COUNT(*) FROM requests') requests," \
  "$(sql -e 'SELECT COUNT(*) FROM client_keys') dashboard clients," \
  "$(sql -e 'SELECT COUNT(*) FROM usage_daily') daily totals."
