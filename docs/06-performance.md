# 06 — Stratégie de performance

## 1. Principe

La performance est une exigence produit, pas une phase d'optimisation. Mais **aucune cible arbitraire n'est présentée comme une garantie** : les budgets sont fixés après la première campagne de mesure, puis maintenus.

Trois règles :

1. **Mesurer avant d'optimiser.** Toute optimisation structurelle cite un scénario, une mesure avant/après et un profil.
2. **Mesurer l'usage réel.** Le nombre de commits n'est qu'une dimension parmi d'autres.
3. **Protéger les acquis.** Un budget tenu devient un test de non-régression.

## 2. Scénarios

| ID | Scénario | Métriques principales | Corpus |
|---|---|---|---|
| PERF-01 | Ouverture à froid d'un dépôt | temps jusqu'à la première page, temps jusqu'à interaction, RSS | 10k / 100k / 1M commits |
| PERF-02 | Affichage initial du graphe | temps de la première page, fps, mémoire | idem + refs nombreuses |
| PERF-03 | Scroll continu | frame time p50/p95, frames manquées, mémoire | 100k commits, lanes nombreuses |
| PERF-04 | Beaucoup de branches et de merges | temps de chargement des refs, fps, mémoire | 5k branches, historique de merges |
| PERF-05 | Grand nombre de fichiers | temps de status, mémoire, fps de la liste | 50k / 200k fichiers |
| PERF-06 | Calcul du working tree status | p50/p95 à froid et à chaud | 10k / 100k fichiers modifiés |
| PERF-07 | Staging partiel | latence aller-retour, cohérence | hunks nombreux, gros fichiers |
| PERF-08 | Diff volumineux | temps du premier hunk, temps complet, mémoire | 10k / 50k lignes, fichiers générés |
| PERF-09 | Changement rapide de dépôts | temps de bascule, pic RSS, fuites | 5 dépôts ouverts en alternance |
| PERF-10 | Fetch et actualisation du graphe | durée, octets IPC, fréquence des événements | dépôt avec 100 nouvelles refs |
| PERF-11 | Repos au repos | CPU %, RSS, wakeups | 5 dépôts ouverts, 10 min |
| PERF-12 | Recherche de commit | temps de première page, p95 | 1M commits |

Chaque scénario définit : préparation, action, mesure, état attendu, seuil de bruit.

## 3. Corpus

### Synthétique (obligatoire, versionné)

Généré par un script déterministe (`crates/bench` ou `scripts/corpus.sh`), avec seed fixe :

| Corpus | Contenu |
|---|---|
| `linear-10k` | 10 000 commits, un fichier qui grossit |
| `linear-100k` | 100 000 commits |
| `linear-1m` | 1 000 000 commits, utilisé uniquement en nightly |
| `branches-5k` | 5 000 branches, refs distantes, tags |
| `merges-deep` | arbre binaire de merges, profondeur 1 000 |
| `merges-octopus` | merges à 8 parents |
| `wide-200k` | 200 000 fichiers répartis en répertoires profonds |
| `dirty-10k` | 10 000 fichiers modifiés/staged/untracked |
| `diff-50k` | un fichier de 50 000 lignes modifié |
| `binary-large` | fichiers binaires de 1 / 50 Mio |
| `crlf-unicode` | fins de ligne mixtes, chemins Unicode, absence de newline |
| `worktrees` | 5 worktrees partageant un common dir |

Les objets générés ne sont pas committés dans le dépôt applicatif ; seuls le générateur, les seeds et les métadonnées le sont.

### Réel (optionnel)

- Dépôts internes représentatifs, utilisés avec accord et sans données sensibles.
- Le rapport enregistre uniquement des métriques et la taille du dépôt, jamais des chemins ou messages.
- L'absence de dépôt réel ne bloque pas la campagne.

## 4. Méthodologie

1. Build `release` avec symboles de profilage.
2. Machine de référence documentée (CPU, RAM, disque, OS, version de Git).
3. 3 exécutions de chauffe, puis 10 mesures.
4. Rapport : médiane, p95, min, max, écart-type ; outliers expliqués.
5. Les comparaisons se font **sur la même machine**, entre deux builds.
6. Les mesures frontend utilisent un scénario scripté (ouverture, scroll programmatique, sélection) et non une interaction humaine.
7. Les mesures Rust utilisent `criterion` pour les parseurs et la topologie.
8. Aucun résultat n'est publié sans version de build, OS et version de Git.

### Rapport

```json
{
  "schema": 1,
  "build": "git-sha / dirty",
  "os": "macos-27-arm64",
  "git": "2.45.0",
  "corpus": "linear-100k",
  "scenario": "PERF-02",
  "runs": [ { "ttfmp_ms": 0, "fps_p95": 0, "rss_mb": 0 } ],
  "summary": { "median": {}, "p95": {} },
  "notes": ""
}
```

## 5. Budgets

### Étape 1 — baseline

La première campagne P0 produit les chiffres. Ils deviennent la référence.

### Étape 2 — budgets produit

Les budgets sont fixés par scénario après la baseline, avec une marge explicite. Exemple de forme :

| Scénario | Budget provisoire `[HYPOTHÈSE]` | Décision |
|---|---|---|
| PERF-01 ouverture 100k commits | première page < 500 ms | à remplacer par la baseline |
| PERF-01 ouverture 1M commits | première page < 1,5 s | nightly seulement |
| PERF-03 scroll | p95 frame < 16,7 ms, aucune frame > 50 ms | à valider |
| PERF-05 status 100k fichiers | chaud < 400 ms | à valider |
| PERF-07 staging | aller-retour < 150 ms | mesuré 35,3 ms p50 / 48,5 ms p95 (dirty-10k, 2026-10-27) |
| PERF-08 diff 50k lignes | premier écran < 200 ms | à valider |
| PERF-09 bascule de dépôt | < 600 ms | à valider |
| PERF-10 fetch + refresh | < 250 ms p95 (remote local, 10k commits) | mesuré 87,2 ms p50 / 98,6 ms p95 (2026-10-27) |
| PERF-11 repos au repos | CPU < 2 %, RSS < 400 Mo | à valider |

Ces valeurs sont des **hypothèses de travail**, pas des engagements. Elles sont remplacées dès la première mesure et ne doivent pas être citées comme garanties.

### Étape 3 — garde-fous CI

- Régression = dépassement de `max(budget absolu, baseline × 1,20)` sur la médiane, ou `× 1,30` sur le p95.
- Un échec de garde-fou bloque la fusion, sauf justification documentée et mise à jour de la baseline.
- Les benchmarks 1M commits tournent en nightly, pas sur chaque PR.

## 6. Instrumentation

### Backend

- Span `tracing` par commande : `repo_id`, `subcommand`, `duration_ms`, `exit_code`, `stdout_bytes`, `stderr_bytes`.
- Compteurs : invocations Git, octets IPC, entrées de cache, invalidations.
- Mesure de chaque phase : lecture, parsing, calcul de topologie, sérialisation.

### Frontend

- `performance.mark` / `measure` : `app.start`, `repo.open`, `graph.first-page`, `graph.first-paint`, `diff.first-paint`.
- Frame timing via `requestAnimationFrame` (p50/p95, frames > 50 ms).
- Mémoire : `performance.memory` si disponible, sinon RSS via le backend.
- Aucune mesure envoyée sur le réseau.

## 7. Rendu du graphe

Contraintes de conception, indépendantes du framework :

1. **Canvas**, pas un nœud DOM par commit.
2. Hauteur de ligne fixe ; seules les lignes visibles + overscan sont dessinées.
3. Topologie et lanes calculées côté Rust à partir des parents ; le frontend dessine des segments.
4. Pagination par fenêtre croissante ; ajout incrémental sans recalcul complet.
5. Aucun recalcul de layout au scroll ; aucun tri à chaque frame.
6. Couleurs par lane, refs regroupées, avatars optionnels (coût mesuré).
7. Le mode « toutes les branches » est un choix explicite, jamais le défaut sur gros dépôt.
8. Une sélection ne déclenche pas de chargement de diff supérieur au plafond.

Algorithme de lanes (résumé) :

- maintenir une table de lanes actives ;
- pour chaque commit, trouver la lane de son premier enfant, fermer les lanes des autres parents, ouvrir les nouvelles ;
- octets/segments produits par page, sans dépendance au nombre total de commits ;
- tests sur merges, octopus, branches mortes, historique non linéaire.

## 8. IPC

- Pages de 500 commits par défaut, taille adaptative pour rester sous 1 Mio.
- Aucun diff dans la page de log.
- Événements de progression coalescés (max ~10/s).
- Les invalidations sont ciblées (`refs`, `index`, `worktree`), pas globales.
- Mesure des octets par scénario ; si le volume devient un goulet, un format binaire peut être envisagé — décision sur mesure.

## 9. Cache et invalidation

| Cache | Clé | Invalidation | Borne |
|---|---|---|---|
| Refs | repo + generation | mutation de refs, watcher | petite |
| Log | repo + cursor + filtres | nouvelle ref, fetch | pages récentes |
| Status | repo + generation | watcher, mutation | une entrée |
| Diff | repo + shas + path | mutation | LRU |
| Topologie | repo + page | nouvelle page | par session |
| GitLab | endpoint + params + ETag | TTL, mutation | LRU |

- Aucune invalidation globale sauf changement de dépôt ou de token.
- Le watcher utilise un debounce de 150 ms et ignore les fichiers internes non pertinents (`objects/`, `logs/`).
- Une modification externe invalide les zones concernées, pas tout le dépôt.

## 10. Ordre des optimisations

1. Supprimer les chargements complets et les attentes bloquantes.
2. Virtualiser les listes et le graphe.
3. Réduire le volume IPC.
4. Corriger l'invalidation de cache.
5. Déplacer les calculs coûteux (topologie, parsing) en Rust.
6. Optimiser le rendu (offscreen canvas, batches, réutilisation de buffers).
7. Envisager `gix` pour une lecture précise, uniquement avec preuve.

Chaque étape doit être justifiée par un profil. Aucune optimisation « au cas où ».

## 11. Tests de performance

| Niveau | Outil | Fréquence |
|---|---|---|
| Parseurs / topologie | `criterion` | PR |
| Scénarios applicatifs | harnais `crates/bench` | PR (corpus réduit), nightly (complet) |
| Frontend | scénario scripté + frame timing | PR (smoke), nightly |
| Mémoire / idle | mesure OS sur 10 min | nightly |
| Régression | comparaison baseline | PR |

Un test de performance qui ne mesure qu'une moyenne est invalide : p95 et frames manquées sont obligatoires pour l'UI.

## 12. Optimisation P3 — pagination du graphe

**Scénario :** PERF-03, ajout de 10 pages de 500 commits.
**Cause :** curseur `--skip=<n>` : chaque page reparcourait tout le préfixe
(≈ 3,8 s/page sur 1 M de commits).
**Correction :** `RepoSession` garde un processus `git log` en flux ; chaque
page lit les lignes suivantes et ne coûte plus que son `--max-count`. Le
curseur devient `index:sha` et retombe sur `--skip` uniquement pour un accès
non séquentiel. Le processus est annulé à la fermeture de session.

| Corpus | Avant (p50, 10 pages) | Après (p50, 10 pages) | Gain |
|---|---|---|---|
| `linear-100k` | 3 587 ms | 18,3 ms | ≈ 196× |
| `linear-1m` | 38 616 ms | 18,3 ms | ≈ 2 110× |

Mesures locales (macOS arm64, Git 2.55.0), rapport :
`target/bench-p3-before-*.json`, `target/bench-p3-after-*.json`.
Le set réduit conserve ses budgets ; PERF-03 est nettement sous la baseline.

### Limite

Le flux conserve un processus par session de dépôt active. Il est annulé au
`shutdown` de la session et ne charge pas l'historique complet en mémoire.
