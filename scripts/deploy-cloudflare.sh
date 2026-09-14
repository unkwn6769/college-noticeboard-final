#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "DEPLOY FAILED: $*" >&2; exit 1; }

command -v node >/dev/null || fail "Node.js is required"
command -v npm >/dev/null || fail "npm is required"

[[ -f .env ]] || fail ".env is required and is not included in the release ZIP."

get_env() {
  local key="$1"
  sed -n -E "s/^${key}=(.*)$/\1/p" .env | tail -1
}

FRONTEND_URL="$(get_env FRONTEND_URL)"
[[ "$FRONTEND_URL" == "https://college-noticeboard.pages.dev" ]] || fail "FRONTEND_URL must be https://college-noticeboard.pages.dev"

echo "== Installing dependencies =="
npm ci
(cd cloudflare/api && npm ci)

export NODE_ENV=production

node --check server/app.js
node --check server/server.js
node --check server/db/database.js
node --check server/runtimeContext.js

(cd cloudflare/api && npx wrangler types && npx tsc --noEmit)

(cd cloudflare/api && npx wrangler deploy --dry-run >/tmp/college-noticeboard-wrangler-dry-run.txt && cat /tmp/college-noticeboard-wrangler-dry-run.txt)

echo "== Deploying Worker =="
WORKER_OUTPUT="$(cd cloudflare/api && npx wrangler deploy 2>&1 | tee /dev/stderr)"
WORKER_URL="$(printf '%s\n' "$WORKER_OUTPUT" | grep -Eo 'https://college-noticeboard-api\.[A-Za-z0-9.-]+\.workers\.dev' | tail -1 || true)"

if [[ -z "$WORKER_URL" ]]; then
  WORKER_URL="$(get_env WORKER_URL)"
fi

[[ -n "$WORKER_URL" ]] || fail "Could not determine Worker URL. Set WORKER_URL in .env and rerun."

EXPECTED_ADMIN_REDIRECT="${WORKER_URL}/api/admin/auth/google/callback"
EXPECTED_DRIVE_REDIRECT="${WORKER_URL}/api/admin/accounts/google/callback"

ADMIN_REDIRECT="$(get_env ADMIN_GOOGLE_REDIRECT_URI)"
DRIVE_REDIRECT="$(get_env DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI)"

if [[ "$ADMIN_REDIRECT" != "$EXPECTED_ADMIN_REDIRECT" || "$DRIVE_REDIRECT" != "$EXPECTED_DRIVE_REDIRECT" ]]; then
  echo
  echo "Worker deployed at: $WORKER_URL"
  echo "Required ADMIN_GOOGLE_REDIRECT_URI: $EXPECTED_ADMIN_REDIRECT"
  echo "Required DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI: $EXPECTED_DRIVE_REDIRECT"
  echo
  echo "Update .env and the two corresponding Google OAuth client redirect URI lists, then rerun this script."
  exit 2
fi

SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT

python3 - "$SECRETS_FILE" <<'PY'
import json
import sys
from pathlib import Path

keys = [
    "TOKEN_ENCRYPTION_KEY",
    "ADMIN_GOOGLE_CLIENT_ID",
    "ADMIN_GOOGLE_CLIENT_SECRET",
    "ADMIN_GOOGLE_REDIRECT_URI",
    "ADMIN_SESSION_SECRET",
    "DRIVE_ACCOUNT_GOOGLE_CLIENT_ID",
    "DRIVE_ACCOUNT_GOOGLE_CLIENT_SECRET",
    "DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI",
]
values = {}
for raw in Path('.env').read_text().splitlines():
    if not raw or raw.startswith('#') or '=' not in raw:
        continue
    key, value = raw.split('=', 1)
    if key in keys:
        values[key] = value
missing = [k for k in keys if not values.get(k)]
if missing:
    raise SystemExit('Missing required secret(s): ' + ', '.join(missing))
Path(sys.argv[1]).write_text(json.dumps(values))
PY

echo "== Uploading Worker secrets =="
(cd cloudflare/api && npx wrangler secret bulk "$SECRETS_FILE")

echo "== Building frontend =="
VITE_API_URL="$WORKER_URL" npm run build

if grep -R "http://localhost:3001" dist/assets >/dev/null; then
  fail "Production frontend bundle still references localhost API"
fi

echo "== Ensuring Pages project exists =="
if ! (npx wrangler pages project list --json | python3 -c 'import json,sys; data=json.load(sys.stdin); print(any(p.get("name") == "college-noticeboard" for p in data))' | grep -q True); then
  npx wrangler pages project create college-noticeboard --production-branch main
fi

echo "== Deploying Pages =="
npx wrangler pages deploy dist --project-name=college-noticeboard --branch=main

echo
echo "DEPLOY COMPLETE"
echo "Frontend: $FRONTEND_URL"
echo "API:      $WORKER_URL"
