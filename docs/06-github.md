# 06 — Intégration GitHub

## 1. Périmètre

GitHub s'ajoute à GitLab sans le remplacer. Les deux fournisseurs sont
indépendants : une session, un jeton, un keychain et des identifiants
d'instance distincts. Un dépôt ne peut être associé qu'à un projet d'un
fournisseur à la fois ; les commandes de chaque fournisseur ne lisent que
l'association qui lui appartient.

Fonctionnalités livrées :

- connexion à `github.com` ou à GitHub Enterprise Server (`/api/v3`) ;
- Personal Access Token stocké dans le keychain (`beebranch.github`) ;
- détection hors ligne d'un jeton déjà présent dans la configuration Git ;
- liste et recherche des dépôts accessibles ;
- association automatique ou manuelle dépôt ↔ projet ;
- pull requests : mes PR, à relire, assignées, projet ; détail et création ;
- revues : approbations, retrait d'approbation, commentaires de revue ;
- checks CI rattachés à la tête de la PR ;
- jobs GitHub Actions du dernier run et logs bornés ;
- badge de PR/CI dans le graphe et sélecteur de clonage.

## 2. URL et authentification

| Entrée | Base REST | Base web |
|---|---|---|
| `https://github.com` | `https://api.github.com` | `https://github.com` |
| `https://api.github.com` | `https://api.github.com` | `https://github.com` |
| `https://github.example.com` | `https://github.example.com/api/v3` | `https://github.example.com` |

Règles :

- `https` obligatoire ; `http` refusé (`github.insecure_url`) ;
- identifiants dans l'URL refusés (`github.url_credentials`) ;
- paramètres et fragment refusés ;
- en-têtes `Authorization: Bearer <token>`, `Accept:
  application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` ;
- validation par `GET /user` ; un `401` émet `github://auth-expired`.

Scopes recommandés : `repo`, `read:user`, `checks:read` (token classique) ou,
pour un token fine-grained, accès au dépôt avec *Contents* en lecture,
*Pull requests* en lecture/écriture, *Checks* en lecture et *Metadata*.

## 3. Endpoints utilisés

| Usage | Endpoint |
|---|---|
| identité | `GET /user` |
| dépôts | `GET /user/repos` ; recherche `GET /search/repositories` |
| dépôt par id | `GET /repositories/{id}` |
| PR d'un dépôt | `GET /repos/{o}/{r}/pulls?state=open` |
| PR transverses | `GET /search/issues?q=is:pr is:open <filtre>` |
| détail | `GET /repos/{o}/{r}/pulls/{n}` |
| création | `POST /repos/{o}/{r}/pulls` |
| checks | `GET /repos/{o}/{r}/commits/{sha}/check-runs` |
| commentaires généraux | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| commentaires de revue | `GET/POST /repos/{o}/{r}/pulls/{n}/comments` |
| réponse à un thread | `POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies` |
| revues | `GET/POST /repos/{o}/{r}/pulls/{n}/reviews` |
| retrait d'approbation | `PUT /repos/{o}/{r}/pulls/{n}/reviews/{id}/dismissals` |
| merge | `PUT /repos/{o}/{r}/pulls/{n}/merge` |
| runs Actions | `GET /repos/{o}/{r}/actions/runs?head_sha={sha}` |
| jobs d'un run | `GET /repos/{o}/{r}/actions/runs/{id}/jobs` |
| logs d'un job | `GET /repos/{o}/{r}/actions/jobs/{id}/logs` (redirection signée) |

Pagination par en-tête `Link: rel="next"`. Les pages sont plafonnées à 100
éléments ; le client s'arrête dès qu'aucun lien suivant n'est présent.

## 4. Modèle de données partagé

Les DTO GitHub reprennent exactement les formes GitLab consommées par l'UI :

| GitHub | Champ normalisé |
|---|---|
| numéro de PR | `iid` |
| id numérique du dépôt | `projectId` |
| login | `author.username` |
| état `open` | `opened` |
| `mergeable: false` | `hasConflicts` |
| `mergeable_state` | `detailedMergeStatus` |
| check-runs | `headPipeline` / pipelines |
| jobs Actions | jobs CI |

`repositoryName` est ajouté aux résultats de recherche transverses pour que
l'application retrouve l'identifiant numérique depuis le cache local.

## 5. Limites de l'API REST

| Fonction | Comportement |
|---|---|
| Résolution d'un thread | non exposée en REST ; l'UI masque « Résoudre » |
| Auto-merge | GraphQL uniquement ; l'UI masque l'option et l'API la refuse |
| Suppression de branche au merge | réglage du dépôt ; l'option est masquée |
| Nombre d'approbations requis | non exposé par la revue de base ; affiché comme inconnu (0) |
| Statut CI d'une liste de PR | non inclus dans `GET /pulls` ; chargé au détail |

Ces limites sont explicites (`github.unsupported`, `github.auto_merge_unsupported`,
`github.remove_branch_unsupported`) et ne dégradent jamais le reste de
l'application.

## 6. Cache, retries et sécurité

- Cache SQLite partagé (`core::http_cache`) avec `ETag` et `If-None-Match`.
- Retries bornés (3) sur `429`, `5xx` et `403` avec quota épuisé
  (`x-ratelimit-remaining: 0`), backoff déterministe.
- Aucun token dans les URLs, les logs, SQLite ou les erreurs ; les détails
  sont redactés (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
- TLS vérifié ; CA interne importable ; redirections non suivies pour les
  requêtes authentifiées.

## 7. Tests

- `crates/github` : normalisation d'URL, remotes, modèle, erreurs, client
  wiremock (auth, pagination `Link`, PR, checks, discussions, revues, merge,
  jobs, logs, cache 304).
- `crates/core` : identifiants `gh_` et redaction des jetons GitHub.
- `crates/store` : isolation `provider` des instances et des associations.
- `crates/app` : sélection des identifiants Git pour GitHub.
- `npm run ui:smoke` : navigation vers « Connexion GitHub » et « Pull requests ».
