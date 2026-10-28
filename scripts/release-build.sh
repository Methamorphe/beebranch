#!/usr/bin/env bash
# Local release build: signs and notarizes the macOS bundle with the
# credentials kept in `.env` (ignored by git). Tauri does not read `.env`
# itself, so the values are exported here; the minisign key and its password
# stay in their ignored files and are never copied into `.env`.
#
# Usage: npm run release:build [-- --bundles dmg]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "absence de .env : cp .env.example .env puis renseigner les credentials" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

missing=()
for name in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH BEEBRANCH_UPDATE_ENDPOINT; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "variables manquantes dans .env : ${missing[*]}" >&2
  exit 1
fi
if [ ! -f "$APPLE_API_KEY_PATH" ]; then
  echo "clé de notarisation introuvable : $APPLE_API_KEY_PATH" >&2
  exit 1
fi

key_file="${TAURI_SIGNING_PRIVATE_KEY_FILE:-src-tauri/keys/release.key}"
password_file="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-src-tauri/keys/release.key.password}"
if [ ! -f "$key_file" ]; then
  echo "clé de signature d'update introuvable : $key_file" >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_file")"
if [ -f "$password_file" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$password_file")"
fi

exec npm run tauri build "$@"
