# ADR-0008 — Aucune sauvegarde applicative ; undo limité à Git

- **Statut :** accepté
- **Date :** 2026-10-27
- **Décideurs :** équipe projet
- **Remplace :** [ADR-0002](0002-explicit-undo-redo.md)

## Contexte

ADR-0002 prévoyait des sauvegardes ciblées avant les actions destructives (contenu de fichiers supprimés, index, refs). La décision produit est de **ne pas maintenir de sauvegardes applicatives** : pas de copie de working tree, pas de quota, pas de rétention.

Cette décision réduit la complexité et le stockage, mais augmente le risque de perte sur les actions destructives. Elle doit rester compatible avec l'exigence « aucune perte silencieuse » : la réponse est la confirmation explicite et l'affichage de l'irréversibilité, pas une promesse d'annulation.

## Décision

1. **Aucune copie applicative** de fichiers, d'index ou de working tree.
2. L'undo/redo ne couvre que les opérations dont l'inverse utilise des **refs, commits, arbres d'index et objets Git**.
3. Sont explicitement **irréversibles** : discard fichier/hunk, `reset --hard`, `stash drop`, `stash apply/pop`, push, fetch, mise à jour de submodule.
4. Les actions irréversibles exigent une confirmation qui décrit l'effet exact et indique qu'aucun undo n'est possible.
5. L'application ne supprime jamais de fichier non suivi ; le discard ne concerne que le contenu suivi.
6. L'undo/redo complet reste en P3 ; les confirmations et le préflight sont en P1.
7. Un échec de restauration affiche la commande, l'étape et le SHA de récupération via le reflog ; aucune réparation automatique.

## Alternatives considérées

| Alternative | Avantages | Inconvénients | Pourquoi rejetée |
|---|---|---|---|
| Sauvegardes ciblées (ADR-0002) | Undo des discard/reset hard | Stockage, quota, nettoyage, complexité | Décision produit : pas de sauvegarde |
| Snapshot complet avant chaque action | Récupération maximale | Coût disque/temps inacceptable | Surdimensionné |
| Aucun undo du tout | Très simple | Perte d'un différenciateur utile | L'undo basé sur Git reste peu coûteux |
| Corbeille OS pour les fichiers supprimés | Récupération | Comportement variable, hors modèle Git | Ne couvre pas les hunks |

## Conséquences

### Positives

- Modèle simple : l'état de référence est Git.
- Aucun stockage annexe, aucun quota, aucune fuite de données dans app data.
- Moins de code et de tests.

### Négatives

- Discard et `reset --hard` sont définitivement perdants pour le travail non commité.
- L'UX doit être très claire sur l'irréversibilité.
- Les incidents de perte de travail sont possibles et acceptés comme risque produit.

### Risques

- **Perte de travail** (R-16) : mitigation par confirmation forte, préflight, aucune suppression de fichier non suivi, et éducation utilisateur.
- **Fausse attente d'undo** : l'UI ne montre jamais d'undo pour une action irréversible.
- **Réintroduction future** : si un incident majeur survient, rouvrir la décision avec un nouvel ADR et des sauvegardes ciblées.

## Critères de révision

Réexaminer après un incident de perte de données significatif, ou si les utilisateurs demandent explicitement la récupération des discard/reset hard. Toute réintroduction de sauvegarde doit définir le stockage, le quota, la rétention, le chiffrement et les tests de restauration.
