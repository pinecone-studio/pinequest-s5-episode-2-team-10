#!/usr/bin/env bash

# Starts the FastAPI API and the Next.js UI for local development.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".venv/bin/activate" ]]; then
  echo "Missing root .venv. Run: uv venv --python 3.12 .venv"
  exit 1
fi

if [[ ! -f ".env" ]]; then
  echo "Missing root .env. Add PITCH_DB_URL before starting the API."
  exit 1
fi

source .venv/bin/activate
set -a
source .env
set +a

# Local, no-GPU defaults. A caller can override these values if needed.
export PITCH_ASR="${PITCH_ASR:-stub}"
export PITCH_EMBEDDINGS="${PITCH_EMBEDDINGS:-none}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:8000}"

cleanup() {
  kill "$api_pid" "$web_pid" 2>/dev/null || true
}

uvicorn backend.main:app --reload --port 8000 &
api_pid=$!

(
  cd web
  npm run dev
) &
web_pid=$!

trap cleanup EXIT INT TERM
wait "$api_pid"
