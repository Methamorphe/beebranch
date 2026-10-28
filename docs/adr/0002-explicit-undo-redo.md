# ADR-0002 — Annulation explicite, jamais universelle

- **Statut :** remplacé par [ADR-0008](0008-no-application-backups.md) (2026-10-27)
- **Date :** 2026-10-27
- **Remplace :** stratégie de snapshots de refs/index de la révision 1

> Conservé pour l'historique. La stratégie de sauvegarde ciblée décrite ici est remplacée par ADR-0008 : aucune sauvegarde applicative, undo limité aux opérations réversibles par Git.

## Contexte

La révision 1 proposait de restaurer les références et l'index avant chaque mutation. Cette approche ne restaure pas le working tree, ne couvre pas les fichiers non suivis, et peut écraser des modifications utilisateur si elle est appliquée sans contrôle.

Git ne fournit pas d'annulation universelle : une opération peut être partiellement appliquée, un hook peut avoir des effets externes, un push ne se défait pas localement, et un `reset --hard` détruit des données non versionnées.

## Décision

1. L'application expose une annulation **uniquement** pour les opérations dont l'inverse est défini et testé.
2. Chaque opération annulable possède :
   - une **inverse typée** (jamais un `reset --hard` générique) ;
   - des **préconditions** vérifiées avant exécution ;
   - les **données capturées** avant mutation ;
   - un comportement défini en cas d'échec partiel.
3. Une empreinte de l'état du dépôt est vérifiée avant toute annulation. Si le dépôt a changé depuis l'opération, l'annulation est refusée avec explication.
4. Les fichiers non suivis, les modifications locales, les conflits et les opérations interrompues sont traités explicitement, jamais ignorés.
5. Les opérations destructives capturent une sauvegarde ciblée avant d'agir (contenu de fichiers supprimés, refs, index), dans un stockage applicatif hors dépôt.
6. Le système complet est P3 et **non bloquant** pour le MVP. Les confirmations et sauvegardes minimales sont en P1.
7. Un push n'est jamais annulable localement. Un force-push exige une confirmation explicite et enregistre l'ancien SHA distant ; restaurer le distant est une action distincte, pas un « undo ».

## Conséquences

- L'UI ne promet jamais « annuler la dernière action » de façon générique.
- Certaines actions sont marquées non annulables.
- Le stockage de sauvegardes doit être borné, nettoyé et documenté.
- Les tests couvrent les échecs partiels et les interruptions.

## Alternatives rejetées

| Alternative | Raison |
|---|---|
| Snapshot complet du dépôt avant chaque action | Coût disque/temps inacceptable sur gros dépôts. |
| `git reset --hard HEAD@{1}` générique | Détruit les modifications locales et les fichiers non suivis ; ne traite pas les états intermédiaires. |
| Undo par rejeu de commandes Git inverses non vérifiées | Faux dans les cas de conflits, hooks, signatures et opérations partielles. |
| Undo universel | Promesse impossible à tenir. |

## Critères de révision

Réexaminer si Git expose une primitive d'annulation sûre et portable, ou si le produit décide d'assumer un snapshot complet pour les très petits dépôts. Toute extension de la matrice exige des tests de restauration et une analyse de perte de données.
