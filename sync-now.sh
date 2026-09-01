#!/bin/bash
set -euo pipefail

# One-command college noticeboard -> cloud synchronization.
# Run this while connected to the college network/lab.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
LOG_DIR="$ROOT_DIR/logs"
LOCK_DIR="$ROOT_DIR/.sync-now.lock"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found: $ENV_FILE" >&2
  exit 1
fi

# Load project environment without printing the API key.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${NINE_DRIVE_URL:?ERROR: NINE_DRIVE_URL is missing from .env}"
: "${NINE_DRIVE_API_KEY:?ERROR: NINE_DRIVE_API_KEY is missing from .env}"

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is not installed or not on PATH." >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || {
  echo "ERROR: curl is not installed or not on PATH." >&2
  exit 1
}

mkdir -p "$LOG_DIR"

# Prevent two syncs from running simultaneously.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "ERROR: another sync is already running." >&2
  echo "Lock: $LOCK_DIR" >&2
  exit 1
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

LOG_FILE="$LOG_DIR/sync-$(date '+%Y-%m-%d_%H-%M-%S').log"
cd "$ROOT_DIR"

# Show the same output on screen and save a timestamped log.
exec > >(tee -a "$LOG_FILE") 2>&1

echo
echo "=========================================="
echo "      COLLEGE NOTICEBOARD SYNC"
echo "=========================================="
echo "Started: $(date)"
echo "Project: $ROOT_DIR"
echo "Log:     $LOG_FILE"
echo

echo "Checking college noticeboard server..."
if ! curl -fsS --connect-timeout 3 --max-time 8 \
  "http://10.24.14.231/noticeboards/" >/dev/null; then
  echo "ERROR: college noticeboard server is not reachable."
  echo "Connect to the college network/lab and run this script again."
  exit 1
fi

echo "College server: OK"
echo "Cloud storage:  $NINE_DRIVE_URL"
echo
echo "Starting synchronization..."
echo

set +e
node "$ROOT_DIR/server/crawler/syncAll.js"
STATUS=$?
set -e

echo
echo "=========================================="
if [[ "$STATUS" -eq 0 ]]; then
  echo "      SYNC FINISHED SUCCESSFULLY"
else
  echo "      SYNC FINISHED WITH ERRORS"
fi
echo "=========================================="
echo "Finished: $(date)"
echo "Log:      $LOG_FILE"
echo

exit "$STATUS"
