# ADR-0005 — Sérialisation par dépôt et IPC borné

- **Statut :** accepté
- **Date :** 2026-10-27
- **Nouveau :** précise l'architecture de la révision 1

## Contexte

Git n'est pas concurrency-safe sur un même dépôt : deux mutations simultanées peuvent corrompre l'index ou produire des états incohérents. Les opérations longues (fetch, push, clone) doivent rester annulables et observables. Les gros payloads IPC (historique complet, diffs massifs) dégradent l'UI et la mémoire.

## Décision

1. **Une session par dépôt** identifiée par son chemin de worktree ; les worktrees partageant un common dir sont connus de la même session.
2. **Mutations sérialisées** par dépôt via un acteur/queue unique. Les lectures peuvent être concurrentes, mais sont bloquées pendant une mutation destructive.
3. Toute opération longue retourne un `operation_id` immédiatement et streame :
   - `progress`, `stdout`, `stderr`, `done`, `error` ;
   - annulation via `cancel_operation`.
4. Aucun gros payload IPC :
   - commits par pages (taille adaptative, 500 par défaut) ;
   - diffs par hunks/fichiers, avec plafond et pagination ;
   - listes de fichiers paginées.
5. Le frontend ne voit jamais un token, un chemin de credential ou une commande shell.
6. Les commandes Tauri sont typées, versionnées et renvoient une erreur structurée.
7. Le processus Git est lancé avec un environnement contrôlé mais respectueux de la configuration utilisateur (SSH agent, credential helpers, PATH, HOME).

## Conséquences

- Les mutations concurrentes sont refusées ou mises en file, avec feedback UI.
- Une opération annulée peut laisser un état intermédiaire : il est détecté et présenté.
- Le format IPC peut évoluer sans casser le frontend grâce au versionnage des commandes.
- Les tests doivent couvrir l'annulation en cours de fetch/push et la détection de `index.lock`.

## Alternatives rejetées

| Alternative | Raison |
|---|---|
| Mutations parallèles | Corruption d'index et états incohérents. |
| Un `git` par clic sans registre d'opérations | Impossible d'annuler, de suivre ou de corréler les erreurs. |
| Payload complet de l'historique | Mémoire et latence inacceptables. |
| Lecture directe de `.git` par le frontend | Fuit la logique et la sécurité hors du backend. |

## Critères de révision

Réexaminer si un besoin de lecture concurrente forte pendant les mutations apparaît, ou si le volume IPC mesuré impose un format binaire (MessagePack) — décision prise sur mesure, pas par anticipation.
