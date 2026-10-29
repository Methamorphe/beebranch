#!/usr/bin/env bash
# Vérifie le DCO 1.1 sur une plage de commits.
#
# Chaque commit non-merge doit contenir un trailer
#   Signed-off-by: Nom <email>
# dont l'adresse correspond à celle de l'auteur du commit.
#
# Usage : scripts/check-dco.sh <base>..<head>
# Les commits de bots (Dependabot, GitHub Actions) sont ignorés.

set -euo pipefail

range="${1:-}"
if [[ -z "$range" || "$range" != *..* ]]; then
  echo "usage: $0 <base>..<head>" >&2
  exit 2
fi

commits="$(git rev-list --no-merges "$range")" || {
  echo "DCO: plage invalide : $range" >&2
  exit 2
}

failed=0
checked=0

while IFS= read -r sha; do
  [[ -n "$sha" ]] || continue

  author_email="$(git log -1 --format=%ae "$sha")"
  author_email_lc="$(printf '%s' "$author_email" | tr '[:upper:]' '[:lower:]')"

  case "$author_email_lc" in
    *'dependabot[bot]'*|*'github-actions[bot]'*) continue ;;
  esac

  checked=$((checked + 1))
  body="$(git log -1 --format=%B "$sha")"
  signed=0

  while IFS= read -r line; do
    line_lc="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    case "$line_lc" in
      "signed-off-by: "*"<$author_email_lc>"*)
        signed=1
        break
        ;;
    esac
  done <<< "$body"

  if (( signed == 0 )); then
    author_name="$(git log -1 --format=%an "$sha")"
    printf 'DCO: %s — %s <%s> sans Signed-off-by correspondant.\n' \
      "${sha:0:12}" "$author_name" "$author_email" >&2
    failed=1
  fi
done <<< "$commits"

if (( failed != 0 )); then
  cat >&2 <<'EOF'

Corrigez avec :
  git commit --amend -s          # dernier commit uniquement
  git rebase --signoff <base>    # série de commits
Puis force-push la branche de la merge request.
EOF
  exit 1
fi

echo "DCO: ${checked} commit(s) vérifié(s), tous signés."
