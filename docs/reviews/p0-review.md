# P0 — Revue de sortie

**Date :** 2026-10-27
**Machine de mesure :** macOS 27 arm64 (Darwin 27.0.0), Rust 1.98.1, Git 2.55.0,
build release LTO.
**Décision :** **NO-GO conditionnel** — deux preuves manquent (instance GitLab
réelle, matrice CI 3 OS exécutée). Le socle technique est démontré et mesuré.

---

## 1. Livrables

| Tâche | État | Preuve |
|---|---|---|
| P0-T01 Scaffold, Tauri 2, CI | fait | `cargo build`, fenêtre lancée, `ci.yml` matrice |
| P0-T02 Couche processus Git | fait | 73 tests lib + `tests/process_contract.rs` (11) |
| P0-T03 Découverte et session | fait | 11 tests `repository_contract` (worktree, submodule, merge, rebase, détaché, locks) |
| P0-T04 Modèle de lecture | fait | 9 tests `read_model` + tests unitaires parseurs |
| P0-T05 Graphe virtualisé | fait | lanes Rust + canvas + mesures PERF-02/03 |
| P0-T06 Diff viewer | fait | hunk/inline/split, plafonds, mesures PERF-08 |
| P0-T07 GitLab self-hosted | fait (live + mock) | instance réelle 19.2.9 + 45 tests wiremock, keychain réel |
| P0-T08 Harnais de benchmark | fait | corpus déterministe, PERF-01..12, baseline, CI/nightly |
| P0-T09 Erreurs et reprise | fait | taxonomie, journal SQLite, reprise, tests de redaction |
| P0-T10 Revue | ce document | — |

## 2. Vérifications exécutées

```text
cargo fmt --all -- --check                       OK
cargo clippy --workspace --all-targets -- -D warnings   OK
cargo test --workspace                           OK (211+ tests)
npm run lint                                     OK (warnings React hooks, 0 erreur)
npm run build                                    OK
cargo build -p beebranch                         OK
./target/debug/beebranch                         fenêtre ouverte, log « application state ready », git=2.55.0
npm run build && node scripts/ui-smoke.mjs       graphe 800 commits, diff 4 000 lignes, captures 1440×900
cargo run -p beebranch-app --example live_gitlab instance réelle : /user, 90 projets, ETag 304, 401, keychain
```

Le smoke UI headless injecte une couche IPC mockée déterministe (pas le
backend), charge le bundle de production dans Chrome, ouvre le dépôt, affiche
le graphe, le status puis le diff et écrit
`docs/reviews/p0-graph.png`, `p0-status.png`, `p0-diff.png`. Mesures :
frame p50/p95 = 16,7 ms, 0 frame manquée sur le scroll/affichage initial,
marqueurs `graph.first-page` et `diff.first-paint` présents, 4 000 lignes
affichées par fenêtrage sans figer l'onglet.

Test de reprise réel : opération `running` → redémarrage → `interrupted`,
`index.lock` signalé et **conservé**. Export de diagnostics sans token
(assertion sur `glpat-`, `PRIVATE-TOKEN`, secret keychain).

## 3. Mesures

Set réduit CI (`--all-reduced --runs 5 --warmup 2`) :

| Scénario | Corpus | p50 | p95 | RSS max | Octets IPC |
|---|---|---:|---:|---:|---:|
| PERF-01 ouverture | linear-10k | 118,3 ms | 120,7 ms | 9,1 Mo | 166 Ko |
| PERF-02 première page graphe | linear-10k | 44,0 ms | 45,6 ms | 9,2 Mo | 210 Ko |
| PERF-03 append 10 pages | linear-10k | 442,2 ms | 455,8 ms | 12,0 Mo | 2,10 Mo cumulés |
| PERF-04 refs | branches-5k (réduit) | 57,1 ms | 59,3 ms | 12,2 Mo | 236 Ko |
| PERF-05 status | wide-200k (20k fichiers) | 176,9 ms | 188,5 ms | 12,2 Mo | 252 o |
| PERF-06 status modifié | dirty-10k (2k fichiers) | 15,6 ms | 26,2 ms | 12,2 Mo | 279 Ko |
| PERF-08 diff | diff-50k (5k lignes en CI) | 15,6 ms | 15,7 ms | 12,9 Mo | 721 Ko |
| PERF-12 recherche log | linear-10k | 44,6 ms | 45,5 ms | 12,9 Mo | 166 Ko |
| PERF-09 bascule worktrees | worktrees (6) | 527,0 ms | 531,4 ms | 9,0 Mo | 31 Ko |
| PERF-11 repos au repos (200 ms) | worktrees (6) | 202 ms | 202 ms | 8,7 Mo | — (CPU 5 %) |

Mesures hors CI :

| Scénario | Corpus | p50 | p95 | RSS max | Octets IPC |
|---|---|---:|---:|---:|---:|
| PERF-02 première page graphe | linear-100k | 345,4 ms | 346,7 ms | 9,8 Mo | 210 Ko |
| PERF-03 append 10 pages | linear-1m | 38,3 s | 38,9 s | 12,4 Mo | 2,11 Mo cumulés |
| PERF-08 diff complet | diff-50k (50k lignes) | 45,8 ms | 46,9 ms | 17,7 Mo | 725 Ko |

Lecture : la mémoire reste bornée par les pages (RSS < 18 Mo sur les corpus
testés, y compris 1M commits), mais le chargement des pages profondes sur 1M
commits coûte ~3,8 s par page à cause de `git log --skip` (10 pages = 38 s).
Ce n'est pas un recalcul de lanes : l'état des lanes est conservé entre les
pages. C'est un point de conception mesure, à traiter en P1/P3 (curseur
incrémental par SHA/date ou parcours `gix` ciblé, avec benchmark avant/après).

Les budgets provisoires de `docs/06-performance.md` sont remplacés par
`crates/bench/baselines/ci.json` pour le set réduit. La baseline est valable
pour cette machine ; elle doit être recalibrée sur le runner GitHub avant
d'être bloquante.

## 4. Décisions des prototypes

### SP-01 Graphe — canvas + lanes Rust conservés

- Canvas, hauteur de ligne fixe, overscan, aucun nœud DOM par commit.
- Lanes calculées en Rust à partir des parents ; tests linéaire, merge, octopus,
  branche morte, continuité de pagination.
- Limites assumées : la densité des lanes est compressée à 42 % de la largeur
  quand elles sont très nombreuses ; au-delà de 16 384 lanes les edges sont
  agrégées et signalées (`overflow`).
- Décision : conserver ce rendu. Aucun fallback DOM/SVG.

### SP-02 Lectures CLI — CLI conservé

Première page 100k à 345 ms, ouverture 10k à 116 ms, status 20k fichiers à
197 ms : aucune preuve ne justifie `gix` en P0. Le coût des sauts profonds est
documenté ci-dessus ; il sera réévalué avec une mesure ciblée.

### SP-06 Diff — rendu fenêtré, coloration maison

- Aucun freeze : seules les lignes visibles sont rendues et colorées ; le
  backend plafonne à 6 000 lignes totales (4 000 par fichier), 100 fichiers,
  4 Mio, avec bandeau de troncature explicite.
- Payload mesuré : 725 Ko pour diff-50k, sous la limite IPC de 1 Mio.
- Décision : pas de bibliothèque de coloration au P0 ; tokenizer borné à la
  fenêtre visible. Une bibliothèque (Shiki/Highlight.js) n'apporterait rien
  sans mesure de coût sur lignes longues.
- Mesure UI headless : 4 000 lignes, `diff.first-paint` présent, frame p95
  16,7 ms sur le rendu (données mockées, rendu réel du bundle).

### SP-05 GitLab — validé en live et en mock

Instance réelle `https://gitlab.beelan.fr/` (19.2.9, certificat public) :
`GET /user` → identité, 90 projets paginés, cache ETag (`304`), token
`[REDACTED]`, 401 → `auth.failed`, SQLite et diagnostics sans token, keychain
macOS réel. Détail : [p0-gitlab-live.md](p0-gitlab-live.md).

45 tests wiremock couvrent 200/304/401/403/404/429/5xx, retry, CA PEM invalide
et l'absence de token dans `Debug`. Restent non exercés en live : matrice
19.3–19.5, préfixe de chemin, CA interne.

## 5. Sécurité

- Token uniquement dans le keychain ; aucune table SQLite ne le contient
  (test de dump), aucun DTO frontend ne l'expose, `Debug` du client et des
  erreurs le masque.
- Redaction centralisée (URL userinfo, `PRIVATE-TOKEN`, `Authorization`,
  `access_token`, `private_token`, `glpat-*`) appliquée aux erreurs Git, aux
  détails d'opérations et aux exports.
- TLS vérifié ; CA interne importée explicitement ; pas de mode « ignorer ».
- Aucun `sh -c` ; argv validé par allowlist ; environnement filtré.
- Export de diagnostics testé sans token.
- Live : TLS public vérifié, token jamais dans SQLite/logs/diagnostics,
  keychain réel. Limite : CA auto-signée, préfixe de chemin et matrice
  19.3–19.5 non exercés (instance pilote en 19.2.9).

## 6. Risques résiduels et bloqueurs

| ID | Élément | Sévérité | Traitement |
|---|---|---|---|
| B-01 | Instance réelle validée en 19.2.9 ; matrice 19.3–19.5, préfixe et CA interne non exercés | Moyen | Lancer SP-05 sur 19.3/19.4/19.5 avec préfixe et CA auto-signée |
| B-02 | Matrice CI Windows/macOS/Linux non exécutée ici | Bloquant P0 | Pousser la PR et vérifier les 3 jobs |
| B-03 | Pages profondes 1M : ~3,8 s/page via `--skip` | Élevé (P1/P3) | Curseur incrémental ou `gix` ciblé, mesure avant/après |
| B-04 | Baseline mesurée sur cette machine seulement | Moyen | Recalibrer sur `macos-latest` avant `--assert` bloquant |
| B-05 | Capture native Tauri indisponible (permission d'enregistrement d'écran) | Faible | Captures du bundle de production via Chrome headless avec IPC mocké (`docs/reviews/p0-*.png`) ; fenêtre native et logs vérifiés |
| B-06 | PERF-07 (staging) et PERF-10 (fetch) non mesurables | Faible | Fonctionnalités P1 ; scénarios déclarés en erreur explicite |
| B-07 | Lanes > 16 384 agrégées | Faible | Signalé dans le graphe ; corpus 5k branches non saturant |
| B-08 | Rendu CRLF : `\r` retiré à l'affichage | Faible | Choix de lisibilité, documenté |

Aucun risque critique non identifié. Aucun verrou n'est supprimé, aucune
sauvegarde applicative n'est créée (ADR-0008 respecté).

## 7. Décision

**NO-GO pour déclarer P0 clos** tant que B-02 n'est pas levé.
**GO technique pour démarrer P1** sur les composants locaux (status, staging,
branches, sync), avec B-03 planifié avant d'annoncer le support 1M commits.
B-01 est levé pour P0 sur une instance réelle ; sa partie « matrice de
versions / CA interne » reste un risque résiduel non bloquant pour P1.

Conditions de passage à GO :

1. Jobs CI verts sur les trois OS (frontend, Rust, smoke Tauri).
2. Baseline recalibrée sur le runner CI ou `--assert` limité au set réduit
   avec budgets absolus.
3. SP-05 complété sur 19.3/19.4/19.5 avant de communiquer le support GitLab
   self-hosted au-delà de l'instance pilote.

## 8. Correctif issu de la preuve live

La validation réelle a révélé que `keyring` était compilé **sans backend**
(features par défaut vides) : `set` réussissait, `get` renvoyait `NoEntry`.
Les features natives sont désormais activées par plateforme
(`apple-native`, `windows-native`, `sync-secret-service`) ; le roundtrip
keychain macOS est prouvé. Sans cette preuve, le token GitLab n'aurait jamais
été persisté.

## 9. Mise à jour des décisions

- Aucune hypothèse d'ADR ne tombe : CLI unique conservé (ADR-0001), canvas
  conservé (ADR-0003), REST v4 conservé (ADR-0004), sérialisation par dépôt
  conservée (ADR-0005), aucune sauvegarde applicative (ADR-0008).
- Le plafond de diff passe de 20 000 à 4 000 lignes par fichier / 6 000 au
  total pour respecter la règle IPC < 1 Mio d'ADR-0005, sans changer la
  décision.
