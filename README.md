# BeeBranch

[![CI](https://github.com/Methamorphe/beebranch/actions/workflows/ci.yml/badge.svg)](https://github.com/Methamorphe/beebranch/actions/workflows/ci.yml)
[![release](https://github.com/Methamorphe/beebranch/actions/workflows/release.yml/badge.svg)](https://github.com/Methamorphe/beebranch/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/Methamorphe/beebranch)](https://github.com/Methamorphe/beebranch/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Client Git desktop **local-first**, open source, écrit en Rust (Tauri 2) et
React 19. Alternative aux clients Git commerciaux pour les équipes qui
travaillent sur GitLab self-hosted et GitHub, sans cloud propriétaire, sans
compte éditeur et sans télémétrie.

- **Git est la source de vérité** : le travail local ne dépend d'aucun service.
- **Un seul moteur Git** : la CLI `git`, centralisée dans un crate Rust.
- **Mises à jour signées** : artefacts minisign, vérifiés avant installation,
  rollback outillé.
- **Pas d'IA, pas de télémétrie** : seuls Git, votre GitLab/GitHub et le
  manifeste de mise à jour sont contactés, sur action de l'utilisateur.

## Télécharger

Les releases sont publiées dans ce dépôt :
<https://github.com/Methamorphe/beebranch/releases/latest>

| Plateforme | Artefact |
|---|---|
| macOS (Apple Silicon) | `BeeBranch_<version>_aarch64.dmg` — signé `Developer ID Application`, notarié et agrafé |
| Windows (x64) | `BeeBranch_<version>_x64-setup.exe` — installateur NSIS, signature Authenticode quand le certificat est configuré |
| Linux (x86_64) | `.AppImage`, `.deb` ou `.rpm` |

Prérequis : Git ≥ 2.34. Les mises à jour suivantes sont installées par
l'application depuis Réglages → Mises à jour, après vérification de la
signature de l'artefact ; la version précédente reste installable
(`rollback.json`).

Si votre plateforme ou architecture n'est pas dans la matrice (macOS Intel par
exemple), compilez depuis les sources.

## Fonctionnalités

- **Dépôts** : ouverture locale, clone GitLab/GitHub ou URL, création par
  `git init` dans un nouveau dossier ou un dossier existant non versionné.
- **Status** : fichiers staged/unstaged/untracked/conflits, stage/unstage
  fichier-hunk-ligne, discard confirmé, ignore explicite, éditeur et merge tool
  externes, blame.
- **Commit** : message, amend, hooks affichés, signature Git respectée.
- **Branches & historique** : création, checkout, renommage, suppression avec
  saisie du nom, upstream, comparaison A→B, merge/rebase, conflits,
  continue/skip/abort, drag & drop.
- **Sync** : fetch/pull/push streamés, annulation, force-with-lease explicite,
  progression et revalidation du remote.
- **Stash, tags, worktrees, sous-modules, patchs, profils**.
- **Recherche** : message/auteur/SHA, profondeur annoncée, annulation.
- **Graphe** : rendu canvas virtualisé, filtres, menu contextuel, badges MR/CI,
  stash via toutes les refs.
- **GitLab** : MR (mes MR, à reviewer, assignées, projet), détail, création,
  pipelines, badge CI, association dépôt ↔ projet.
- **GitHub** : pull requests, détail, création, revues et approbations,
  commentaires de revue, checks CI et logs Actions, association dépôt ↔ projet.
- **Multi-dépôts** : workspaces, onglets, sessions isolées, onglet actif
  restauré.
- **Undo/redo explicite** : matrice d'opérations réversibles par Git, aucune
  sauvegarde applicative ([ADR-0008](docs/adr/0008-no-application-backups.md)).
- **Reprise après crash** : journal d'opérations, actions destructives tracées.

## Développement

Prérequis : Rust ≥ 1.85, Node ≥ 22, Git ≥ 2.34 et les dépendances système
[Tauri 2](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

Build de production local (sans signature de release) :

```bash
npm run tauri build
```

Le pipeline de release (signature macOS, notarisation, artefacts minisign,
manifestes et rollback) est décrit dans [docs/releases/README.md](docs/releases/README.md).

### Vérifications

```bash
npm run lint
npm run build
npm run audit:telemetry
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Test d'interface headless (captures dans `target/ui-smoke/`) :

```bash
npm run ui:smoke
```

### Benchmarks

Les budgets de performance viennent de mesures reproductibles, pas
d'estimations ([ADR-0003](docs/adr/0003-benchmark-first-and-canvas.md)).

```bash
# set réduit, bloquant sur régression (baseline versionnée)
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --all-reduced \
  --runs 5 --warmup 2 \
  --out target/bench-report.json \
  --baseline crates/bench/baselines/ci.json --assert

# scénarios ciblés
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus dirty-10k \
  --scenario PERF-07 --runs 3 --warmup 1
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus linear-10k \
  --scenario PERF-10 --runs 3 --warmup 1
```

### Structure

```text
crates/
  core/       types partagés et contrats UI
  git/        processus Git, index/commit/branches/sync/history/stash/search, lanes
  gitlab/     client REST v4, URL/CA, cache ETag, remote matching
  github/     client REST v3, GitHub Cloud/Enterprise, checks, Actions, remotes
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

## Décisions structurantes

| Sujet | Décision | ADR |
|---|---|---|
| Moteur Git | **Git CLI uniquement** au démarrage, centralisé dans un module Rust | [ADR-0001](docs/adr/0001-git-cli-single-engine.md) |
| Undo / Redo | Annulation **explicite**, limitée aux opérations réversibles par Git, **aucune sauvegarde applicative** | [ADR-0008](docs/adr/0008-no-application-backups.md) |
| Performance | **Benchmark-first** : corpus et scénarios réels, budgets issus des mesures, rendu canvas virtualisé | [ADR-0003](docs/adr/0003-benchmark-first-and-canvas.md) |
| GitLab | REST v4, PAT + keychain OS, endpoints non dépréciés, dégradation hors ligne | [ADR-0004](docs/adr/0004-gitlab-rest-v4.md) |
| GitHub | REST v3, Cloud et Enterprise Server, séparation stricte des fournisseurs | [06-github](docs/06-github.md) |
| Concurrence / IPC | Mutations sérialisées par dépôt, streaming pour les opérations longues, pas de gros payloads IPC | [ADR-0005](docs/adr/0005-per-repo-serialization-and-ipc.md) |
| Frontend | **React 19.3** + TypeScript + Vite | [ADR-0006](docs/adr/0006-react-frontend.md) |
| Mises à jour | `tauri-plugin-updater`, artefacts minisign, `latest.json` + `rollback.json` dans GitHub Releases | [ADR-0009](docs/adr/0009-signed-updates.md) |
| Versions | React stable, Git ≥ 2.34 (plancher LTS distro), GitLab 3 dernières maintenues | [ADR-0007](docs/adr/0007-version-baseline.md) |
| Identité visuelle | Ergonomie inspirée des conventions des clients Git, palette Beecoming, assets propres | [10-design-direction](docs/10-design-direction.md) |
| Worktrees | Identité de dépôt et sessions **worktree-aware dès P0** | [01-product-scope](docs/01-product-scope.md) |

## Documentation

| Document | Contenu |
|---|---|
| [docs/SPECIFICATION.md](docs/SPECIFICATION.md) | Spécification consolidée P0–P3, décisions structurantes et règles de développement |
| [docs/01-product-scope.md](docs/01-product-scope.md) | Objectifs, non-objectifs, principes, inventaire P0–P3, critères d'acceptation |
| [docs/02-architecture.md](docs/02-architecture.md) | Architecture cible, crates, modules, frontières Tauri, IPC, états, erreurs, sécurité |
| [docs/03-git-engine.md](docs/03-git-engine.md) | Moteur Git CLI : commandes, parsing, streaming, annulation, conflits, worktrees, LFS |
| [docs/04-undo-redo.md](docs/04-undo-redo.md) | Matrice de réversibilité, préconditions, stockage, restauration, tests |
| [docs/05-gitlab.md](docs/05-gitlab.md) | GitLab : authentification, endpoints, flux, cache, offline, TLS, erreurs |
| [docs/06-github.md](docs/06-github.md) | GitHub Cloud/Enterprise : authentification, endpoints, limites REST |
| [docs/06-performance.md](docs/06-performance.md) | Corpus, scénarios, métriques, budgets |
| [docs/07-reliability-security.md](docs/07-reliability-security.md) | Préflight, confirmations, reprise après crash, modèle de menace, secrets, TLS |
| [docs/08-roadmap.md](docs/08-roadmap.md) | Phases, dépendances, Definition of Done, stratégie de tests |
| [docs/09-risks-and-prototypes.md](docs/09-risks-and-prototypes.md) | Registre des risques et décisions ouvertes |
| [docs/10-design-direction.md](docs/10-design-direction.md) | Direction visuelle, densité, garde-fous IP |
| [docs/releases/](docs/releases/) | Notes de version et processus de release |
| [docs/adr/](docs/adr/) | Décisions structurantes (ADR) |

## Contribuer et sécurité

Les contributions sont acceptées **exclusivement via merge requests**
(pull requests GitHub) : `main` est protégée, aucun push direct n'est autorisé.
Chaque commit doit porter un `Signed-off-by` (DCO 1.1) et la CI doit passer.

- [CONTRIBUTING.md](CONTRIBUTING.md) : environnement, conventions, périmètre,
  exigences de vérification et de preuve.
- [SECURITY.md](SECURITY.md) : signalement privé des vulnérabilités, modèle de
  menace et périmètre de support.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) : règles de comportement.

## Licence

BeeBranch est distribué sous **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`, voir [LICENSE](LICENSE)). Toute version modifiée distribuée ou
exposée comme service doit publier son code source correspondant.

Les marques, le logo et les assets visuels BeeBranch ne sont pas couverts par la
licence du code : leur réutilisation doit être demandée aux mainteneurs.
