#!/usr/bin/env bash
# Creates an encrypted backup of the database, .env and config, and copies it off-site
# when LLMR_BACKUP_REMOTE is set. Run it from cron, for example:
#   15 3 * * * cd /opt/llm-rudder && ./deploy/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${LLMR_ENV_FILE:-.env}"
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

DIR="${LLMR_BACKUP_DIR:-backups}"
KEEP_DAYS="${LLMR_BACKUP_KEEP_DAYS:-14}"
REMOTE="${LLMR_BACKUP_REMOTE:-$(setting LLMR_BACKUP_REMOTE)}"
[ -n "$(setting LLMR_BACKUP_PASSPHRASE)" ] || { echo "Set LLMR_BACKUP_PASSPHRASE in $ENV_FILE." >&2; exit 1; }

umask 077
mkdir -p "$DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

docker compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --no-tablespaces -uroot -p"$MYSQL_ROOT_PASSWORD" llm_rudder 2>/dev/null' \
  </dev/null >"$WORK/database.sql"
tail -n 1 "$WORK/database.sql" | grep -q "Dump completed" || { echo "The database dump is incomplete." >&2; exit 1; }
cp "$ENV_FILE" "$WORK/env"
cp config/config.yaml "$WORK/config.yaml"

NAME="llm-rudder-$(date -u +%Y%m%dT%H%M%SZ).backup"
tar -C "$WORK" -cf - database.sql env config.yaml | gzip -c |
  docker compose run --rm -T --no-deps gateway node dist/cli.js backup-seal >"$DIR/.$NAME.tmp"
mv "$DIR/.$NAME.tmp" "$DIR/$NAME"
find "$DIR" -name 'llm-rudder-*.backup' -type f -mtime "+$KEEP_DAYS" -delete

case "$REMOTE" in
  "") ;;
  rclone:*)
    rclone copyto "$DIR/$NAME" "${REMOTE#rclone:}/$NAME"
    rclone delete --min-age "${KEEP_DAYS}d" --include 'llm-rudder-*.backup' "${REMOTE#rclone:}"
    ;;
  *:*)
    scp -q "$DIR/$NAME" "$REMOTE/$NAME"
    ssh "${REMOTE%%:*}" "find '${REMOTE#*:}' -name 'llm-rudder-*.backup' -type f -mtime +$KEEP_DAYS -delete"
    ;;
  *) echo "LLMR_BACKUP_REMOTE must be user@host:/path or rclone:remote:path." >&2; exit 1 ;;
esac

echo "Backup written: $DIR/$NAME ($(wc -c <"$DIR/$NAME" | tr -d ' ') bytes)"
