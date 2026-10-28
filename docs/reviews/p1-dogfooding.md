# P1 — Protocole et rapport de dogfooding

**Date :** 2026-10-27
**Statut :** non exécuté — requiert trois développeurs volontaires.

## 1. Objectif

Vérifier qu'une journée de travail complète est réalisable sans GitKraken ni
terminal pour les opérations P1 :

branche → staging partiel → commit → push → MR → review simple → merge →
résolution de conflit → stash → changement de dépôt.

## 2. Préparation

1. Installer 0.2.0 sur macOS, Linux et Windows.
2. Ouvrir trois dépôts réels (dont un avec hooks et un dépôt GitLab self-hosted).
3. Configurer l'instance GitLab et associer chaque dépôt à son projet.
4. Activer un enregistrement d'écran et le journal d'opérations.

## 3. Scénario imposé

| Étape | Attendu | Trace |
|---|---|---|
| Créer une branche depuis le graphe | branche créée et checkout | capture + `git branch --show-current` |
| Modifier deux lignes séparées | stage d'un hunk puis de l'autre | diff index + `git diff --cached` |
| Committer avec un hook volontairement en échec | commit refusé, sortie visible, message conservé | capture + `git log -1` |
| Corriger et committer | commit créé, signature si configurée | `git log --show-signature` |
| Fetch/pull/push | progression visible ; push non-ff refusé avec remédiation | capture |
| Créer une MR | MR ouverte, badge CI dans le graphe | capture + URL |
| Merge avec conflit | conflit visible, résolution dans l'éditeur, Mark résolu, Continue | capture + état final |
| Abort d'un rebase | état restauré, saisie `abort` demandée | capture |
| Stash puis pop conflictuel | stash intact après conflit | `git stash list` |
| Ouvrir 5 dépôts en alternance | aucune fuite mesurée, erreurs isolées | RSS/CPU + captures |
| Fermer un onglet avec opération | confirmation explicite | capture |
| Redémarrer l'application | onglet actif restauré, conflit/merge toujours affiché | capture |

## 4. Mesures

- RSS avant/après 10 changements d'onglet (plafond à définir : +50 MiB).
- Latence perçue des actions de staging (< 100 ms sur le corpus de test).
- Nombre de retours au terminal (cible : 0 hors P2).
- Incidents de perte de données (cible : 0).

## 5. Blocages et backlog

À remplir pendant la session :

| # | Étape | Symptôme | Contournement | Sévérité | Décision |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## 6. Couverture automatisée disponible avant la session

- `cargo test --workspace` : 269 tests, dont 40 tests P1 dédiés et le workflow
  quotidien complet.
- `npm run ui:smoke` : graphe, diff, sélection de ligne, staging IPC, vues P1.
- `PERF-07`/`PERF-10` : budgets versionnés.

Ces preuves ne remplacent pas le critère humain : trois développeurs doivent
encore exécuter le scénario ci-dessus.
