# BeeBranch — spécification consolidée

**Statut :** P3 implémenté et vérifié — preuves dans [docs/reviews/p3-review.md](docs/reviews/p3-review.md). Le dogfooding humain reste à exécuter.
**Date :** 2026-10-27
**Nom du produit :** BeeBranch
**Frontend :** React 19.3 + TypeScript + Vite
**Compatibilité :** Git ≥ 2.34 (testé 2.55.0) / GitLab 19.3–19.5 (dernières versions maintenues)
**Périmètre actuel :** P3 — finition : P2 + undo/redo explicite, drag & drop branche/commits, design system et densité, pages de graphe en flux pour les gros dépôts, workspaces multi-dépôts, accessibilité auditée, distribution signée et mises à jour/rollback signés.

---

## 1. Objet

Remplacer GitKraken dans l'entreprise par **BeeBranch**, un client Git desktop :

- **local-first** : Git est la source de vérité, le travail local ne dépend d'aucun service ;
- **rapide et prévisible** : performance mesurée, pas supposée ;
- **fiable** : aucune perte de données silencieuse, états Git intermédiaires visibles ;
- **intégré à GitLab self-hosted** dès le premier produit utilisable ;
- **maintenable** : un seul moteur Git, peu d'abstractions, périmètre contrôlé ;
- **sans IA, sans cloud propriétaire, sans télémétrie intrusive, sans compte éditeur**.

## 2. Décisions structurantes

| Sujet | Décision | ADR |
|---|---|---|
| Moteur Git | **Git CLI uniquement** au démarrage, centralisé dans un module Rust | [ADR-0001](docs/adr/0001-git-cli-single-engine.md) |
| Undo / Redo | Annulation **explicite**, limitée aux opérations réversibles par Git, **aucune sauvegarde applicative** ; livrée en P3 | [ADR-0008](docs/adr/0008-no-application-backups.md) |
| Performance | **Benchmark-first** : corpus et scénarios réels, budgets issus des mesures, rendu canvas virtualisé | [ADR-0003](docs/adr/0003-benchmark-first-and-canvas.md) |
| GitLab | REST v4, PAT + keychain OS, endpoints non dépréciés, dégradation hors ligne | [ADR-0004](docs/adr/0004-gitlab-rest-v4.md) |
| Concurrence / IPC | Mutations sérialisées par dépôt, streaming pour les opérations longues, pas de gros payloads IPC | [ADR-0005](docs/adr/0005-per-repo-serialization-and-ipc.md) |
| Frontend | **React 19.3** + TypeScript + Vite | [ADR-0006](docs/adr/0006-react-frontend.md) |
| Versions | React stable, Git ≥ 2.34 (plancher LTS distro), GitLab 3 dernières maintenues | [ADR-0007](docs/adr/0007-version-baseline.md) |
| Identité visuelle | Ergonomie inspirée de GitKraken, **palette Beecoming** (accent `#FED100`, décliné `#F5BB45` dans la maquette P2), assets propres | [10-design-direction](docs/10-design-direction.md) |
| Worktrees | Identité de dépôt et sessions **worktree-aware dès P0**, interface complète livrée en P2 | [01-product-scope](docs/01-product-scope.md) |
| GitLab dans le MVP | Intégration obligatoire en P0/P1, pas en P2 | [01-product-scope](docs/01-product-scope.md) |

## 3. Corrections appliquées à la révision 1

| Décision initiale | Correction | Impact |
|---|---|---|
| `gix` en lecture + CLI en écriture + `git2` ponctuel | CLI unique ; `gix` seulement si un benchmark prouve un gain significatif | Suppression de deux moteurs et de leurs divergences ; lecture initiale à mesurer |
| Undo par snapshots de refs/index | Matrice explicite d'opérations réversibles par Git, préconditions, **aucune sauvegarde applicative** | Plus de promesse d'annulation universelle ; les actions destructives sont explicitement irréversibles |
| Benchmark centré sur 1 M de commits | Suite de scénarios représentatifs (branches, merges, fichiers, diffs, changement de dépôt, idle) | Les optimisations sont choisies sur preuve, pas sur intuition |
| GitLab en phase ultérieure | GitLab obligatoire en P0 (connexion) et P1 (workflow MR/CI) | Le premier produit est utilisable en entreprise |
| Worktrees uniquement P2 | Modèle de dépôt worktree-aware dès P0 | Évite une refonte du moteur de session |
| Abstractions backend pressenties | Aucune abstraction de moteur ni de provider avant besoin réel | Moins de code, moins de tests, décisions réversibles documentées |

Décisions de la révision 1 **conservées** : local-first, Tauri 2, rendu canvas virtualisé, chargement incrémental, aucun token dans le frontend, TLS vérifié, pas d'IA/cloud/télémétrie, GitLab REST v4, délégation des opérations Git complexes à Git.

### 3.1 Versions de référence

| Composant | Référence retenue | Justification |
|---|---|---|
| React | **19.3** (canal Latest) | React n'a pas de canal LTS ; Latest est le canal stable recommandé pour les applications utilisateur ([politique React](https://react.dev/community/versioning-policy)). |
| TypeScript / Vite | Dernière stable, version exacte épinglée au scaffold | Pas de LTS ; versions figées dans le lockfile. |
| Git | **Plancher 2.34**, cible et tests sur **2.56.0** | Git n'a pas de canal LTS ; 2.34 est la version fournie par Ubuntu 22.04 LTS, ce qui couvre les distributions LTS courantes. Feature detection au-delà. |
| GitLab | **3 dernières versions maintenues** (19.3, 19.4, 19.5 au 2026-10-27), cible latest stable | GitLab n'a pas de LTS ; sa politique officielle ne maintient que les trois dernières versions mensuelles ([maintenance](https://docs.gitlab.com/policy/maintenance/)). Feature detection pour les instances plus anciennes. |

## 4. Index documentaire

| Document | Contenu |
|---|---|
| [docs/01-product-scope.md](docs/01-product-scope.md) | Objectifs, non-objectifs, principes, inventaire complet P0–P3, critères d'acceptation |
| [docs/02-architecture.md](docs/02-architecture.md) | Architecture cible, crates, modules, frontières Tauri, IPC, états, erreurs, sécurité |
| [docs/03-git-engine.md](docs/03-git-engine.md) | Moteur Git CLI : commandes, parsing, streaming, annulation, conflits, worktrees, LFS |
| [docs/04-undo-redo.md](docs/04-undo-redo.md) | Matrice de réversibilité, préconditions, stockage, restauration, tests |
| [docs/05-gitlab.md](docs/05-gitlab.md) | Authentification, endpoints, flux, cache, offline, TLS, erreurs, modèle de données |
| [docs/06-performance.md](docs/06-performance.md) | Corpus, scénarios, métriques, instrumentation, budgets, gouvernance |
| [docs/07-reliability-security.md](docs/07-reliability-security.md) | Préflight, confirmations, reprise après crash, modèle de menace, secrets, TLS |
| [docs/08-roadmap.md](docs/08-roadmap.md) | Phases, tâches, dépendances, Definition of Done, stratégie de tests |
| [docs/09-risks-and-prototypes.md](docs/09-risks-and-prototypes.md) | Registre des risques, prototypes obligatoires, décisions ouvertes |
| [docs/10-design-direction.md](docs/10-design-direction.md) | Direction visuelle, densité, inspiration GitKraken, garde-fous IP |
| [docs/tasks/](docs/tasks/) | Fiches de tâches prêtes à être confiées à un agent |
| [docs/releases/](docs/releases/) | Notes de version utilisées par le manifeste de mise à jour |
| [docs/adr/](docs/adr/) | Décisions structurantes |

## 5. Distribution et mises à jour

- Packaging via `npm run tauri build` ; `release.yml` construit les trois OS et
  signe/notarise quand les secrets `APPLE_*` et `TAURI_WINDOWS_CERTIFICATE`
  existent. Depuis 0.5.1, le build macOS Apple Silicon est signé
  `Developer ID Application`, notarié et agrafé (app et DMG) ; les releases
  restent produites en local. Voir [docs/releases/README.md](docs/releases/README.md).
- `latest.json` et `rollback.json` sont générés par
  `scripts/update-manifest.mjs` et `scripts/merge-manifests.mjs`.
- Aucune télémétrie : `npm run audit:telemetry` vérifie les sources.

### Installer une build (macOS, Apple Silicon)

1. Télécharger le DMG de la dernière release :
   <https://github.com/Methamorphe/beebranch-releases/releases/latest>
   (`BeeBranch_<version>_aarch64.dmg`). Le dépôt public suffit : aucun accès au
   code source n'est nécessaire.
2. Ouvrir le DMG, glisser `BeeBranch.app` dans `/Applications`.
3. Depuis 0.5.1, la build est signée et notariée : Gatekeeper l'accepte sans
   contournement. Pour une version antérieure (non notariée), macOS tue le
   premier lancement (signal 9) ; deux voies, au choix :
   - Réglages Système → Confidentialité et sécurité → « Ouvrir quand même »,
     puis relancer l'application ;
   - ou en terminal : `xattr -dr com.apple.quarantine /Applications/BeeBranch.app`.
4. Contrôle : `/Applications/BeeBranch.app/Contents/MacOS/beebranch --version`
   doit afficher `BeeBranch <version>`.

Limites de la matrice publiée : `darwin-aarch64` uniquement (pas de build Intel),
aucun installateur Windows/Linux. Prérequis d'usage : Git ≥ 2.34. Les mises à
jour suivantes sont installées par l'application, après vérification de la
signature minisign de l'artefact.

## 6. Règles de lecture pour un agent de développement

1. Une tâche = une fiche dans `docs/tasks/`, un périmètre fermé, une PR.
2. Ne pas élargir le périmètre : toute fonctionnalité absente de la fiche est hors scope.
3. Ne pas introduire d'abstraction non demandée (trait de backend Git, système de plugins, provider GitLab générique).
4. Une fonctionnalité n'est **pas** terminée parce que l'UI existe : critères d'acceptation + tests + preuve d'exécution réelle.
5. Toute affirmation de performance doit être accompagnée d'une mesure reproductible.
6. Toute hypothèse non vérifiée doit rester marquée `[HYPOTHÈSE]` dans le code, les tests ou la doc.

## 7. Décisions encore ouvertes

Voir [docs/09-risks-and-prototypes.md §4](docs/09-risks-and-prototypes.md). Les principales :

- support des dépôts bare, shallow et partial clone au MVP ;
- mécanisme de mise à jour et de signature des binaires ;
- niveau d'accessibilité cible ;
- chiffrement éventuel du cache local ;
- diff MR calculé via l'API ou via la ref locale ;
- autorisation éventuelle de HTTP non TLS ;
- politique de télémétrie (aucune par défaut).

## 8. Démarrage

Prérequis : Rust ≥ 1.85, Node ≥ 22, Git ≥ 2.34, dépendances système Tauri 2.

```bash
npm install
npm run tauri dev
```

Fonctionnalités P1 disponibles dans l'application :

- **Status** : fichiers staged/unstaged/untracked/conflits, stage/unstage
  fichier-hunk-ligne (diff interactif), discard confirmé, ignore explicite,
  éditeur/merge tool externes.
- **Commit** : message, amend, hooks affichés, signature Git respectée.
- **Branches & historique** : création, checkout, renommage, suppression avec
  saisie du nom, upstream, comparaison, merge/rebase, conflits,
  continue/skip/abort.
- **Sync** : fetch/pull/push streamés, annulation, force-with-lease explicite,
  progression et revalidation du remote.
- **Stash** : create/list/apply/pop/drop, untracked sur choix explicite,
  pop conflictuel non destructif.
- **Multi-dépôts** : onglets, sessions isolées, onglet actif restauré.
- **Recherche** : message/auteur/SHA, profondeur annoncée, annulation.
- **Graphe** : filtres, menu contextuel, badges MR/CI, stash via toutes les refs.
- **GitLab** : MR (mes MR, à reviewer, assignées, projet), détail, création,
  pipelines, badge CI, association dépôt ↔ projet.
- **Outils** : détection/configuration éditeur, terminal, diff, merge.
- **Reprise** : journal d'opérations, actions destructives tracées, reprise
  après interruption.

Vérifications :

```bash
npm run lint
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Benchmarks :

```bash
# set réduit, bloquant sur régression (baseline versionnée)
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --all-reduced \
  --runs 5 --warmup 2 \
  --out target/bench-report.json \
  --baseline crates/bench/baselines/ci.json --assert

# scénarios P1 ciblés
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus dirty-10k \
  --scenario PERF-07 --runs 3 --warmup 1
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus linear-10k \
  --scenario PERF-10 --runs 3 --warmup 1

# corpus 100k, première page du graphe
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus linear-100k \
  --scenario PERF-02 --runs 3 --warmup 1 \
  --out target/bench-graph-100k.json
```

Structure actuelle :

```text
crates/
  core/       types partagés et contrats UI
  git/        processus Git, index/commit/branches/sync/history/stash/search, lanes
  gitlab/     client REST v4, URL/CA, cache ETag, remote matching
  store/      SQLite (journal, cache, préférences) et keychain
  app/        shell Tauri : commandes typées, setup, logging, reprise
  bench/      corpus déterministe, scénarios PERF, rapports et seuils
src/
  components/ composants réutilisables
  hooks/      hooks de présentation
  data/       données statiques de l'UI
  styles/     tokens et styles globaux
src-tauri/    bootstrap Tauri et configuration
```

Pour régénérer les icônes après modification du logo :

```bash
npm run tauri icon assets/beebranch.svg
```
