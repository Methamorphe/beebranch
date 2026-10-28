# Baselines de performance

`ci.json` est la baseline utilisée par `.github/workflows/bench.yml` sur le set
réduit (`--all-reduced`).

## Machine de référence (mesure initiale)

| Élément | Valeur |
|---|---|
| Date | 2026-10-27 |
| OS | macOS 27 (Darwin 27.0.0), arm64 (Apple Silicon) |
| CPU / RAM | machine de développement, non virtualisée |
| Rust | 1.98.1 |
| Git | 2.55.0 |
| Build | `cargo run -p beebranch-bench --release` (profil release, LTO) |
| Commande | `beebranch-bench --root target/bench-corpus --all-reduced --runs 5 --warmup 2 --out …` |

Les valeurs `p50_ms` / `p95_ms` sont les mesures brutes du rapport
(`summary.p50Ms`, `summary.p95Ms`), arrondies à 3 décimales. Aucune valeur
n'est estimée.

Les scénarios sous 100 ms (`PERF-04`, `PERF-06`, `PERF-08`, `PERF-12`)
portent en plus un budget absolu `abs_p95_ms = p95 mesuré × 2 + 10 ms` afin
d'absorber les outliers du planificateur avec 5 mesures (le p95 au rang le plus
proche y est le maximum). Le facteur relatif `× 1,30` reste actif lorsque la
mesure dépasse ce budget.

## Mise à jour

1. Lancer le harnais sur la machine de référence, sans `--assert`.
2. Vérifier la stabilité (deux exécutions consécutives sous les seuils).
3. Reporter les nouvelles valeurs `p50_ms` / `p95_ms` mesurées.
4. Justifier le changement dans la PR (régression assumée, nouvelle machine,
   changement de corpus ou d'implémentation).

Ne jamais « ajuster » une baseline pour faire passer une régression non
expliquée.
