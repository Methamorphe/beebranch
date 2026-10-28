# ADR-0006 — React 19.3 + TypeScript + Vite

- **Statut :** accepté
- **Date :** 2026-10-27
- **Décideurs :** équipe projet

## Contexte

BeeBranch est une application desktop dense : graphe d'historique, diff, listes virtualisées, panneaux redimensionnables, GitLab. Le frontend doit être maintenable, testable et capable d'héberger un rendu canvas sans imposer de framework lourd.

React n'a pas de canal LTS : le canal **Latest** est le canal stable recommandé pour les applications utilisateur, et les versions suivent SemVer ([politique React](https://react.dev/community/versioning-policy)). La version stable au 2026-10-27 est **19.3**.

## Décision

1. Frontend en **React 19.3**, TypeScript en mode strict, build **Vite**.
2. Pas de kit UI imposé au démarrage : composants maison, tokens de design.
3. Le graphe est rendu en **canvas** ; React ne rend pas un nœud par commit.
4. L'état métier reste dans le backend Rust ; React ne détient que l'état de présentation.
5. Les versions exactes de React, TypeScript et Vite sont épinglées dans le lockfile au scaffold.

## Alternatives considérées

| Alternative | Avantages | Inconvénients | Pourquoi rejetée |
|---|---|---|---|
| Svelte 5 | Bundle plus léger, réactivité simple | Écosystème plus petit, moins de recrutement | Pas de gain déterminant puisque le graphe est en canvas |
| SolidJS | Très performant sur le DOM | Écosystème et outillage plus restreints | Risque de maintenance |
| Vanilla TS | Contrôle total | Coût de structure et de tests | Productivité insuffisante |
| React 18 | Plus ancien, stable | Pas de LTS, moins de fonctionnalités | Aucune raison de partir sur une version antérieure |

## Conséquences

### Positives

- Écosystème mature (virtualisation, tests, outillage).
- TypeScript strict et typage IPC partagé.
- Recrutement et maintenance facilités.
- Aucune dépendance à un méta-framework.

### Négatives

- React reste une dépendance à suivre (majeures peu fréquentes).
- Le rendu canvas doit être géré hors du modèle React.

### Risques

- **Performance UI** : le risque est le rendu, pas React. Mitigation : canvas, virtualisation, mesure P0.
- **Dérive de dépendances** : limiter les bibliothèques, audit, versions épinglées.

## Critères de révision

Réexaminer si les mesures P0 montrent que le modèle de rendu React est un goulet, ou si l'équipe ne peut pas maintenir l'écosystème. Un changement de framework ne doit pas modifier les frontières backend/IPC.
