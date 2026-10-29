#!/usr/bin/env bash
# Applique la protection de `main`, l'immutabilité des tags de release et les
# fonctionnalités de sécurité GitHub après le passage du dépôt en public.
#
# Les rulesets, le secret scanning et les advisories privées ne sont pas
# disponibles sur un dépôt privé en plan gratuit : exécuter ce script une fois
# le dépôt public.
#
# Usage : scripts/setup-github-protection.sh [owner/repo]

set -euo pipefail

repo="${1:-Methamorphe/beebranch}"
if ! command -v gh >/dev/null 2>&1; then
  echo "gh est requis" >&2
  exit 1
fi

visibility="$(gh repo view "$repo" --json visibility --jq .visibility)"
if [[ "$visibility" != "PUBLIC" ]]; then
  echo "Le dépôt $repo est $visibility : le passer en public avant d'appliquer la protection." >&2
  exit 1
fi

create_or_update_ruleset() {
  local name="$1"
  local payload="$2"
  local id
  id="$(gh api "repos/$repo/rulesets" \
    --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null || true)"

  if [[ -n "$id" ]]; then
    echo "mise à jour du ruleset « $name » ($id)"
    gh api -X PUT "repos/$repo/rulesets/$id" --input - < "$payload" >/dev/null
  else
    echo "création du ruleset « $name »"
    gh api -X POST "repos/$repo/rulesets" --input - < "$payload" >/dev/null
  fi
}

branch_ruleset="$(mktemp)"
tag_ruleset="$(mktemp)"
cleanup() {
  rm -f "$branch_ruleset" "$tag_ruleset"
}
trap cleanup EXIT

cat > "$branch_ruleset" <<'JSON'
{
  "name": "main - merge requests uniquement",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash"],
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Frontend" },
          { "context": "Rust (ubuntu-latest)" },
          { "context": "Rust (macos-latest)" },
          { "context": "Rust (windows-latest)" },
          { "context": "DCO" }
        ]
      }
    }
  ],
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ]
}
JSON

cat > "$tag_ruleset" <<'JSON'
{
  "name": "tags de release immuables",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ]
}
JSON

create_or_update_ruleset "main - merge requests uniquement" "$branch_ruleset"
create_or_update_ruleset "tags de release immuables" "$tag_ruleset"

echo "activation du signalement privé de vulnérabilités"
gh api -X PUT "repos/$repo/private-vulnerability-reporting" >/dev/null

echo "activation des alertes Dependabot et des correctifs automatiques"
gh api -X PUT "repos/$repo/vulnerability-alerts" >/dev/null
gh api -X PUT "repos/$repo/automated-security-fixes" >/dev/null

echo "activation du secret scanning et de la protection contre les push"
gh api -X PATCH "repos/$repo" --input - >/dev/null <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "secret_scanning_non_provider_patterns": { "status": "enabled" }
  }
}
JSON

echo
echo "état final :"
gh api "repos/$repo/rulesets" \
  --jq '.[] | "  ruleset \(.id) — \(.name) (\(.target), \(.enforcement))"'
gh api "repos/$repo" \
  --jq '"  secret_scanning=\(.security_and_analysis.secret_scanning.status) push_protection=\(.security_and_analysis.secret_scanning_push_protection.status)"'
echo "  dépôt : $visibility"
