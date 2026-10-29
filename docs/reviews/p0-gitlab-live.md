# P0-T07 — Preuve sur instance GitLab réelle

**Date :** 2026-10-27
**Instance :** `https://gitlab.example.com/` (self-hosted, anonymisée)
**Version :** GitLab **19.2.9** (`/api/v4/version`, `enterprise: false`)
**TLS :** certificat public valide (`ssl_verify_result=0`), aucune CA interne
**Identité :** `jdoe` (id 35)
**Token :** PAT lu depuis un fichier local `0600`, jamais affiché ni journalisé.

## Commandes exécutées

```bash
curl -sS https://gitlab.example.com/api/v4/version
# {"version":"19.2.9", ...}

cargo run -q -p beebranch-app --example live_gitlab
# GITLAB_URL / GITLAB_TOKEN_FILE surchargent les valeurs par défaut

TEST_KEYCHAIN=1 cargo run -q -p beebranch-app --example live_gitlab
LIVE_KEYCHAIN=1 cargo run -q -p beebranch-app --example live_gitlab
```

L'exemple exerce le **vrai chemin applicatif** : normalisation d'URL,
`GitlabClient`, validation `GET /user`, pagination projets, cache ETag,
`configure` (validation + persistance SQLite + secret), `projects_page`
(persistance des projets), `diagnostics` redacté et keychain OS.

## Résultats

```text
normalized base=https://gitlab.example.com api=https://gitlab.example.com/api/v4 host=gitlab.example.com
debug=GitlabClient { api_url: "https://gitlab.example.com/api/v4", host: "gitlab.example.com", token: "[REDACTED]", ... }

user id=35 username=jdoe name=Jane Doe
projects first page items=40 next=Some(3) total=Some(90)
project detail id=149 path=example-group/example-app http_url_has_token=false
projects second call cached=true not_modified=true items=40
bad token code=auth.failed status=Some(401) retryable=false detail=Some(false)

configured connected=true instance=https://gitlab.example.com user=jdoe
projects_via_app_client items=90 total=Some(90)
projects_page persisted items=3 next=None
persisted instances=1 identity=jdoe projects_cached=3 secret_present=true
sqlite_contains_token=false sqlite_contains_private_token_header=false
diagnostics_contains_token=false diagnostics_contains_instance=true
bad_token code=auth.failed detail_has_token=false
keychain_roundtrip=true keychain_value_len=Some(15) keychain_cleaned=true

# avec LIVE_KEYCHAIN=1 : configure stocke le PAT via KeychainStore
persisted instances=1 identity=jdoe projects_cached=3 secret_present=true
live_keychain_secret_cleaned=true
```

## Couverture

| Exigence T07 | Résultat |
|---|---|
| Connexion valide | `GET /user` → 200, identité `jdoe` |
| Connexion invalide | 401 → `auth.failed`, non retryable |
| Token absent des logs | `Debug` client/config → `[REDACTED]` |
| Token absent de SQLite | dump complet → aucun `glpat-`, aucun `private-token` |
| Token absent du frontend/diagnostics | export → aucun token |
| Token dans le keychain | `configure` avec `KeychainStore` : écriture, lecture, suppression vérifiées |
| Pagination | 40 éléments, `X-Next-Page=3`, total 90 |
| Cache ETag | second appel `cached=true`, `not_modified=true` |
| URLs de remote sans token | `http_url_has_token=false` |
| Erreurs 401/403/404/409/422/429/5xx | 401 live ; autres couvertes par wiremock (45 tests) |
| TLS | certificat public vérifié |
| CA interne | non exercée (instance à certificat public) |
| Préfixe d'URL | non exercé (instance à la racine) |
| Versions 19.3–19.5 | non exercé : instance en **19.2.9** |

## Limites et suites

- L'instance réelle est en **19.2.9**, sous la cible documentée 19.3–19.5.
  Les endpoints P0 (`/user`, `/projects`, `/projects/:id`) fonctionnent, mais la
  matrice de versions et la feature detection avancée (approvals, pipelines)
  restent à exécuter sur 19.3/19.4/19.5.
- Une seule instance : préfixe de chemin et CA interne non validés en live.
- 403/429/5xx live non provoqués volontairement ; le mapping est couvert par
  wiremock.
- Le secret du test keychain a été supprimé immédiatement après lecture.

## Conclusion

La démonstration de connexion, la liste/recherche de projets, la persistance et
les contrôles d'absence de token sont **levés sur une instance réelle**. La
matrice GitLab 19.3–19.5 et le cas CA interne restent des risques résiduels
documentés.
