#!/usr/bin/env bash
# Replaces the gateway instances without interrupting requests. New instances start first,
# and each old one then finishes its work before it stops. If the new ones do not become
# ready, they are removed and the old ones keep running.
# Usage: ./deploy/rolling-update.sh   (after building or pulling the new gateway image)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

READY_WAIT_S="${LLMR_READY_WAIT_S:-120}"
DRAIN_WAIT_S="${LLMR_DRAIN_WAIT_S:-300}"
READY_CHECK="fetch('http://127.0.0.1:4141/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

instances() { docker compose ps -q gateway; }
scale() { docker compose up -d --no-deps --no-build --no-recreate --scale "gateway=$1" gateway; }

OLD="$(instances)"
COUNT="$(printf '%s\n' "$OLD" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No gateway instance is running." >&2
  exit 1
fi

echo "Starting $COUNT new instance(s) next to the $COUNT running."
scale "$((COUNT * 2))"
NEW="$(instances | grep -v -x -F -f <(printf '%s\n' "$OLD") || true)"

is_ready() { docker exec "$1" node -e "$READY_CHECK" >/dev/null 2>&1; }
for id in $NEW; do
  waited=0
  until is_ready "$id"; do
    waited=$((waited + 1))
    if [ "$waited" -ge "$READY_WAIT_S" ]; then
      echo "A new instance did not become ready, so the running ones stay in place." >&2
      docker logs --tail 20 "$id" >&2 || true
      # shellcheck disable=SC2086
      docker rm -f $NEW >/dev/null
      exit 1
    fi
    sleep 1
  done
done

echo "New instances are ready. Letting the old ones finish their requests."
# shellcheck disable=SC2086
docker stop --time "$DRAIN_WAIT_S" $OLD >/dev/null
# shellcheck disable=SC2086
docker rm $OLD >/dev/null
scale "$COUNT"
echo "Update finished: $COUNT instance(s) running."
