# ADR-0007 — Socle de versions : React stable, Git 2.34+, GitLab maintenu

- **Statut :** accepté
- **Date :** 2026-10-27
- **Décideurs :** équipe projet

## Contexte

La consigne initiale était de « prendre la version LTS ». Vérification faite :

- **React** n'a pas de canal LTS ; le canal Latest est le canal stable recommandé ([politique React](https://react.dev/community/versioning-policy)). Version stable : **19.3** au 2026-10-27.
- **Git** n'a pas de canal LTS. La version dépend de la distribution. Dernière version : **2.56.0** (2026-09-28) ([git-scm](https://git-scm.com/)).
- **GitLab** n'a pas de canal LTS. Sa politique officielle maintient uniquement les **trois dernières versions mensuelles** ; au 2026-10-27 : **19.5, 19.4, 19.3** ([maintenance](https://docs.gitlab.com/policy/maintenance/)).

Choisir « la dernière version » casserait les postes dont Git vient du système, et GitLab self-hosted est souvent en retard sur la dernière release.

## Décision

| Composant | Référence | Détail |
|---|---|---|
| React | **19.3** | Canal Latest, version épinglée au scaffold |
| TypeScript / Vite | Dernière stable | Versions exactes épinglées dans le lockfile |
| Git | **Plancher 2.34**, cible **2.56.0** | 2.34 = version d'Ubuntu 22.04 LTS ; couvre les distributions LTS courantes. CI sur 2.34 et 2.56.0, feature detection entre les deux. |
| GitLab | **19.3–19.5** au 2026-10-27 | Les trois dernières versions maintenues. Cible = latest stable. Tests sur trois versions, feature detection pour les instances plus anciennes. |

Règles :

- Aucune fonctionnalité ne dépend d'une version supérieure sans fallback ou message explicite.
- La version détectée est affichée dans les diagnostics.
- Une montée de plancher (Git ou GitLab) exige un ADR de révision et une campagne de tests.

## Alternatives considérées

| Alternative | Avantages | Inconvénients | Pourquoi rejetée |
|---|---|---|---|
| Dernière Git 2.56 obligatoire | Fonctionnalités récentes | Casse les postes avec Git système | Incompatible avec un parc hétérogène |
| Git 2.39 plancher | Correspond à Debian 12 / RHEL 9 | Exclut Ubuntu 22.04 LTS | Trop restrictif sans connaître le parc |
| GitLab 19.5 uniquement | Tests simples | Ne reflète pas la réalité self-hosted | Trop fragile |
| Attendre une « LTS » GitLab | — | Elle n'existe pas | Impossible |

## Conséquences

### Positives

- Fonctionne sur les distributions LTS courantes.
- Le client reste utilisable avec un GitLab légèrement en retard.
- Le feature detection évite les suppositions de version.

### Négatives

- Matrice de tests Git/GitLab plus large.
- Certaines fonctionnalités récentes ne sont pas disponibles partout.

### Risques

- **Parc plus ancien que 2.34** : message bloquant, procédure de mise à jour documentée.
- **GitLab plus ancien que 19.3** : fonctionnalités désactivées, pas d'échec global.
- **Évolution de la politique GitLab** : revoir le plancher à chaque release majeure.

## Critères de révision

Réexaminer si le parc minimum change, si GitLab modifie sa politique de maintenance, ou si une fonctionnalité critique exige une version plus récente.
