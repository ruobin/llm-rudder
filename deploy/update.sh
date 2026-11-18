#!/usr/bin/env bash
# Moves this server to a published image, and goes back if the new one does not become ready.
# Usage: ./deploy/update.sh [version]   (a version tag, sha-abc1234, or latest)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${1:-latest}"
PREVIOUS="$(cat .deployed-version 2>/dev/null || true)"
PORT="$(sed -n 's/^LLMR_PORT=//p' .env | tail -n 1)"
FILES=docker-compose.yml:docker-compose.ghcr.yml
if grep -q '^COMPOSE_FILE=.*docker-compose.scale.yml' .env; then
  FILES="$FILES:docker-compose.scale.yml"
  ROLLING=yes
fi
export COMPOSE_FILE="$FILES"
compose() { docker compose "$@"; }
ready() {
  for _ in $(seq 1 60); do
    curl -fsS --max-time 2 "http://127.0.0.1:${PORT:-4141}/readyz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

export LLMR_VERSION="$VERSION"
compose pull --quiet gateway
if [ "${ROLLING:-}" = yes ]; then
  # New instances start before old ones stop, and a failed start changes nothing.
  ./deploy/rolling-update.sh
else
  compose up -d --no-build
fi
if ready; then
  echo "$VERSION" >.deployed-version
  echo "Now running $VERSION."
  exit 0
fi

echo "Version $VERSION did not become ready." >&2
if [ -n "$PREVIOUS" ]; then
  export LLMR_VERSION="$PREVIOUS"
  compose up -d --no-build
  ready && echo "Went back to $PREVIOUS." >&2
fi
exit 1
