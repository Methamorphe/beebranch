# ADR-0004 — GitLab self-hosted via REST v4 et PAT

- **Statut :** accepté
- **Date :** 2026-10-27
- **Étend :** intégration GitLab de la révision 1, désormais obligatoire dès P0/P1

## Contexte

L'entreprise utilise une instance GitLab self-hosted comme plateforme centrale. L'intégration ne peut pas être un ajout tardif : le premier produit utilisable doit permettre de cloner, suivre les MR et voir la CI.

Contraintes : versions variables, certificats internes, URL avec préfixe, pagination, rate limits, tokens expirés, fonctionnement offline des opérations Git locales.

## Décision

1. Client **REST v4** dédié (`/api/v4`), sans SDK générique.
2. Authentification par **Personal Access Token** (`PRIVATE-TOKEN`), scopes `api` + `read_user`.
3. Token stocké dans le **keychain OS**, jamais dans le frontend, les logs ou les URLs de remote.
4. Validation de connexion via `GET /user`.
5. Endpoints actuels uniquement :
   - diffs de MR via `/merge_requests/:iid/diffs` ;
   - pas d'usage de `/merge_requests/:iid/changes` (déprécié depuis GitLab 15.7).
6. Support d'une **autorité de confiance configurable** pour les certificats internes. La vérification TLS n'est jamais désactivée silencieusement.
7. Cache local avec ETag/TTL ; toutes les opérations Git locales fonctionnent hors ligne ; les vues GitLab affichent les dernières données connues avec un indicateur de fraîcheur.
8. Feature detection plutôt que supposition de version/palier : les endpoints indisponibles (approvals Premium, etc.) sont désactivés proprement.
9. Aucune abstraction `GitProvider` tant qu'un second provider n'est pas réellement requis.

## Conséquences

- Le client doit gérer les préfixes d'URL, proxys et CA internes.
- Les erreurs 401/403/404/409/422/429/5xx ont un mapping explicite.
- Les mutations GitLab ne sont pas mises en file hors ligne au MVP.
- La compatibilité est testée contre les trois dernières versions maintenues de GitLab self-managed (pas de canal LTS).

## Alternatives rejetées

| Alternative | Raison |
|---|---|
| GraphQL | Plus puissant pour le batch, mais surface plus instable et complexité inutile pour le périmètre MVP. |
| SDK GitLab générique | Dépendance large, comportements opaques, versions imposées. |
| Token dans le remote HTTPS | Fuite dans `.git/config` et l'historique shell. |
| Désactivation TLS globale | Risque de sécurité inacceptable. |

## Critères de révision

Réexaminer si le nombre d'appels REST devient un goulet mesuré (agrégation multi-projets), ou si GitLab impose une migration d'API. Une bascule GraphQL devrait rester localisée au module `gitlab`.
