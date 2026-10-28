# ADR-0003 — Performance mesurée et rendu canvas virtualisé

- **Statut :** accepté
- **Date :** 2026-10-27
- **Complète :** stratégie de performance de la révision 1

## Contexte

La performance est un motif central du remplacement de GitKraken. La révision 1 avançait des cibles (1 M de commits, ouverture < 1 s, 60 fps) sans corpus ni méthode. Ces chiffres ne sont pas des garanties et ne représentent pas nécessairement l'usage réel.

Tauri ne rend pas une interface rapide par lui-même : le rendu du graphe, le volume d'IPC et la politique de chargement déterminent l'expérience.

## Décision

1. **Aucune optimisation structurelle sans mesure.** Les budgets sont fixés après la première campagne de référence.
2. La campagne couvre des scénarios représentatifs : ouverture à froid, affichage initial, scroll, branches/merges nombreux, nombreux fichiers, status, staging partiel, gros diffs, changement de dépôt, fetch/refresh, mémoire et CPU au repos.
3. Le corpus combine :
   - des dépôts synthétiques générés et versionnés par script ;
   - des dépôts internes réels, utilisés seulement si disponibles et anonymisables.
4. Le graphe est rendu en **canvas** (ou équivalent) avec virtualisation stricte, chargement incrémental et topologie calculée côté Rust.
5. Aucun échange IPC par commit. Les payloads sont paginés et bornés.
6. Les métriques et budgets sont versionnés ; les régressions sont détectées en CI sur un corpus fixe.
7. Les optimisations sont ordonnées par preuve (profil, mesure), pas par intuition.

## Conséquences

- Les premiers chiffres sont des **hypothèses** explicitement marquées, remplacées par la baseline.
- Le prototype de graphe est un livrable P0, pas un détail d'implémentation.
- Les budgets doivent tolérer la variabilité des machines CI (comparaison relative, médiane/p95, plusieurs runs).
- Un budget non tenu déclenche une décision documentée : optimiser, réduire le périmètre ou réviser l'architecture (ADR).

## Alternatives rejetées

| Alternative | Raison |
|---|---|
| Cibles arbitraires présentées comme garanties | Non vérifiables, risque de fausse confiance. |
| Benchmark uniquement sur 1 M de commits | Ne représente pas les goulets réels (branches, fichiers, diffs, changements de dépôt). |
| DOM/SVG avec un nœud par commit | Coût mémoire et rendu incompatible avec les gros historiques. |
| Optimiser d'abord, mesurer ensuite | Investissement sans priorité. |

## Critères de révision

Réexaminer si le canvas ne permet pas l'accessibilité requise, si la densité d'information demandée l'exige, ou si les mesures montrent un autre goulet dominant.
