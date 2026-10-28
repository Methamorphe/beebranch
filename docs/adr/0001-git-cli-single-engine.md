# ADR-0001 — Git CLI comme moteur unique

- **Statut :** accepté
- **Date :** 2026-10-27
- **Remplace :** décision de révision 1 (`gix` lecture + CLI écriture + `git2` ponctuel)

## Contexte

Le client doit fonctionner avec les dépôts, configurations et outils existants de l'entreprise : hooks, LFS, worktrees, submodules, SSH, signatures GPG/SSH, credential helpers, filtres, configuration globale et locale.

La révision 1 proposait trois moteurs :

- `gix` pour les lectures rapides ;
- Git CLI pour les mutations ;
- `git2`/libgit2 pour certains cas.

Cette combinaison multiplie les chemins de code, les divergences de comportement et les tests. Elle suppose aussi un gain de performance non mesuré. Aucun besoin produit ne justifie trois moteurs au démarrage.

## Décision

1. **Git CLI est le seul moteur Git** utilisé par l'application au démarrage.
2. Toutes les invocations passent par un module Rust unique (`git`), qui :
   - construit les commandes en **argv** (jamais de shell, jamais d'interpolation) ;
   - impose des formats machine-readable (`--porcelain`, `-z`, formats explicites) ;
   - capture `stdout`, `stderr`, le code de sortie et la durée ;
   - gère l'annulation, le streaming et les timeouts ;
   - sérialise les mutations par dépôt.
3. `gix` ne peut être introduit que si un benchmark reproductible démontre un gain **significatif** sur un chemin de lecture identifié, sans changer le comportement observable.
4. Aucun trait `GitBackend`, aucun système de plugins, aucune seconde implémentation n'est créé à l'avance.

## Conséquences

**Positives**

- Un seul comportement Git, identique à celui du terminal et de la CI.
- Hooks, LFS, signatures, worktrees, submodules et credential helpers fonctionnent sans réimplémentation.
- Surface de test réduite.
- Les erreurs Git réelles peuvent être remontées à l'utilisateur.

**Négatives**

- Coût de démarrage d'un processus par opération (mesuré, généralement faible).
- Parsing de sorties texte à maintenir.
- Certaines lectures massives peuvent être plus lentes qu'une implémentation native ; c'est un problème de performance à mesurer, pas une raison architecturale.
- Dépendance à une version minimale de Git et à ses options.

**Neutres**

- Le module `git` isole les commandes : remplacer une lecture précise par `gix` reste possible sans toucher au reste de l'application.

## Alternatives rejetées

| Alternative | Raison |
|---|---|
| `gix` partout | Ne couvre pas push, merge de commits, rebase, reset (état du projet au 2026-10). |
| `git2` partout | Divergences possibles avec les hooks, LFS, signatures et credential helpers ; deuxième modèle de comportement. |
| Hybride immédiat | Complexité et tests doubles sans preuve de gain. |

## Critères de révision

Réexaminer cet ADR si :

- un scénario de benchmark P0 dépasse son budget et que la cause est le coût du processus ou du parsing ;
- `gix` couvre les opérations manquantes avec une stabilité suffisante ;
- un besoin produit exige une lecture impossible ou trop lente via CLI.

Toute révision doit inclure : mesure avant/après, périmètre exact, tests de non-régression, et mise à jour de cet ADR.
