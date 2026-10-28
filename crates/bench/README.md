# beebranch-bench — harnais de performance

Harnais déterministe pour les scénarios **PERF-01..PERF-12** de
`docs/06-performance.md`. Il pilote le vrai modèle de lecture de
`beebranch-git` (découverte, état, log, lanes, refs, status, diff) et produit un
rapport JSON versionné (`schema: 1`).

Ce crate n'est pas embarqué dans l'application.

## Corpus

Les corpus sont générés sous `--root` (défaut `target/bench-corpus`) par un
unique `git fast-import` puis vérifiés par `git reset --hard` :

| Corpus | Contenu | Réduit (CI PR) |
|---|---|---|
| `linear-10k` | 10 000 commits, `history.txt` | identique |
| `linear-100k` | 100 000 commits | identique |
| `linear-1m` | 1 000 000 commits (nightly) | identique |
| `branches-5k` | 100 commits, 5 000 branches, 500 tags, 5 000 refs distantes | 500 / 50 / 500 |
| `merges-deep` | 1 000 fusions en chaîne (2 parents chacune) | 200 fusions |
| `wide-200k` | 200 000 fichiers dans 1 024 répertoires | 20 000 fichiers |
| `dirty-10k` | 10 000 fichiers modifiés / indexés / non suivis | 2 000 fichiers |
| `diff-50k` | `big.txt` de 50 000 lignes modifié | 5 000 lignes |
| `crlf-unicode` | CRLF, EOL mixtes, chemin Unicode, fichier sans `\n` final | identique |
| `worktrees` | 5 worktrees liés partageant un `common dir` | identique |

Déterminisme : graine fixe (`--seed`, défaut 42), identité
`BeeBranch Bench <bench@beebranch.local>`, dates `1_600_000_000 + index` et
contenu dérivé d'un splitmix64. Un marqueur `.git/.beebranch-bench-corpus.json`
rend la génération idempotente ; un corpus marqué est réutilisé après
vérification de son nombre de commits.

Git n'est jamais lancé via `std::process` : tout passe par `GitRunner` /
`CommandSpec`. Seul `ps` (mesure RSS) est exécuté hors `beebranch-git`.

Sous-commandes Git utilisées par le générateur : `init`, `config --local`,
`fast-import` (flux unique pour tout l'historique), `reset --hard`,
`rev-list --count`, `add`, `worktree add`. `init`, `rev-list` et `fast-import`
ont été ajoutés à l'allowlist de `beebranch-git` (seule modification de ce
crate, avec `merge -m/--message`) ; aucune n'est utilisée par l'application.

## Commandes

Mesure d'un scénario :

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus \
  --corpus linear-10k --scenario PERF-01 \
  --runs 5 --warmup 2 \
  --out target/bench-report.json
```

Les corpus ne sont pas committés : seuls le générateur, les seeds, la baseline
et ce README sont versionnés.

Set CI réduit (utilisé par `.github/workflows/bench.yml`) :

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --all-reduced \
  --runs 5 --warmup 2 \
  --out target/bench-report.json \
  --baseline crates/bench/baselines/ci.json --assert
```

Nightly (complet, non bloquant) :

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus \
  --corpus linear-100k --scenario PERF-01 \
  --runs 5 --warmup 2 --out target/nightly-perf01-100k.json
```

## Scénarios implémentés

`PERF-01` ouverture à froid · `PERF-02` première page de graphe ·
`PERF-03` append de 10 pages · `PERF-04` refs · `PERF-05` status arbre large ·
`PERF-06` status worktree modifié · `PERF-07` staging partiel (hunk) ·
`PERF-08` diff volumineux ·
`PERF-09` changement entre 5 worktrees (ouverture + première page) ·
`PERF-10` fetch local + refresh status/refs ·
`PERF-11` 5 dépôts au repos (RSS, CPU, fenêtre `BEEBRANCH_BENCH_IDLE_MS`,
défaut 5 000 ms) · `PERF-12` recherche de commits.

`PERF-07` stage un hunk puis restaure l'index ; `PERF-10` crée un remote bare
local minuscule, fetch, puis relit status et refs. Aucun résultat inventé.

Le set `--all-reduced` contient les dix scénarios mesurables en CI PR
(`PERF-01` .. `PERF-08`, `PERF-10`, `PERF-12`) ; `PERF-09` et `PERF-11` se
lancent manuellement ou en nightly.

## Rapport

`runs[]` contient `durationMs`, `rssKb`, `ipcBytes` (taille JSON sérialisée des
données lues) et `items`. `summary` contient `p50Ms`, `p95Ms`, `minMs`,
`maxMs`, `meanMs`, `rssKbMax`, `ipcBytesMax`. Les percentiles utilisent le rang
le plus proche (5 mesures → p50 = 3ᵉ valeur, p95 = 5ᵉ).

## Seuils

`--assert --baseline <fichier>` compare chaque scénario à la baseline :

- médiane autorisée = `max(abs_p50_ms éventuel, floor 2 ms, p50_ms × 1,20)` ;
- p95 autorisé = `max(abs_p95_ms éventuel, floor 2 ms, p95_ms × 1,30)`.

Les champs optionnels `abs_p50_ms` / `abs_p95_ms` permettent de fixer un
budget absolu (utile pour absorber les outliers de planification sur les
opérations courtes). Un scénario absent de la baseline est une régression.

Codes de retour : `0` succès, `1` régression, `2` erreur du harnais ou
d'usage.

Avec `--assert` sur un scénario unique, un corpus absent est refusé ; générez-le
d'abord sans `--assert`. `--all-reduced` génère ses corpus réduits (la CI peut
donc démarrer à froid).

## Baseline

`crates/bench/baselines/ci.json` a été mesurée sur la machine de référence
décrite dans `crates/bench/baselines/README.md`. Une baseline est valable pour
une machine et un build donnés ; toute mise à jour doit être justifiée dans la
PR (scénario, avant/après, profil ou explication du bruit).
