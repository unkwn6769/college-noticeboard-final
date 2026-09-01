#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required."
  exit 1
fi

# Install dependencies automatically when needed.
if [ ! -d "$ROOT_DIR/node_modules" ] || [ ! -d "$ROOT_DIR/server/node_modules" ]; then
  echo "[setup] Installing dependencies..."
  npm install
else
  echo "[setup] Dependencies already installed."
fi

cleanup() {
  echo
  echo "[dev] Stopping frontend and backend..."
  if [ -n "${FRONT_PID:-}" ] && kill -0 "$FRONT_PID" 2>/dev/null; then
    kill "$FRONT_PID" 2>/dev/null || true
  fi
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  wait "$FRONT_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[server] Starting backend..."
(
  npm run server:dev 2>&1 | sed 's/^/[server] /'
) &
SERVER_PID=$!

echo "[frontend] Starting Vite frontend..."
(
  npm run dev 2>&1 | sed 's/^/[frontend] /'
) &
FRONT_PID=$!

echo

echo "[dev] Backend + frontend are starting."
echo "[dev] Frontend: http://localhost:5173"
echo "[dev] Press Ctrl+C to stop both."
echo

# macOS Bash 3.2 does not support `wait -n`; poll both children instead.
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[dev] Backend stopped."
    break
  fi
  if ! kill -0 "$FRONT_PID" 2>/dev/null; then
    echo "[dev] Frontend stopped."
    break
  fi
  sleep 1
done
