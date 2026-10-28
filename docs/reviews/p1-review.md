# P1 — Revue de sortie

**Date :** 2026-10-27
**Version :** 0.2.0
**Décision :** GO technique pour P1. Le critère humain de P1-T14 reste ouvert.

## 1. Périmètre livré

| Domaine | Implémentation | Tests |
|---|---|---|
| Staging fichier/hunk/ligne | `crates/git/src/index.rs` | `crates/git/tests/p1_ops.rs` (ligne, hunk, CRLF, no-newline, unicode, mode, rename) |
| Commit/amend | `crates/git/src/commit.rs` | hook échec/succès, identité absente, index vide, amend keep/replace |
| Branches | `crates/git/src/branches.rs` | préflight, non mergée, courante, dirty checkout, upstream, comparaison |
| Sync | `crates/git/src/sync.rs` | bare remote local, push, fetch, pull ff-only, force-with-lease policy |
| Merge/rebase/conflits | `crates/git/src/history.rs` | conflit/résolution/continue, abort, reprise session, refus de double opération |
| Stash | `crates/git/src/stash.rs` | create/pop/drop, pop conflictuel, SHA récupérable |
| Recherche | `crates/git/src/search.rs` | message/auteur/SHA, profondeur |
| GitLab | `crates/gitlab/src/models.rs`, `client.rs`, `pipeline.rs` | contrat wiremock liste/création/draft/422/pipelines, mapping tous statuts |
| Destructif | `crates/core/src/actions.rs`, journal SQLite | confirmation absente, saisie erronée, action réversible |
| Outils externes | `crates/app/src/commands/tools.rs` | placeholders, chemins, URL non sûre |
| Workflow complet | `crates/git/tests/p1_workflow.rs` | branche → staging → commit → stash → push → merge conflictuel → continue → fetch |

## 2. Vérifications exécutées

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings   → OK
cargo test --workspace                                  → 269 tests OK
npm run lint                                            → 0 erreur (avertissements React d'effets)
npm run build                                           → OK
npm run ui:smoke                                        → OK
```

`ui:smoke` exerce le graphe, le diff, la sélection de ligne, l'appel
`index_unstage`, et l'ouverture des vues P1.

Benchmarks :

```text
PERF-07 dirty-10k full, 3 runs : p50 35.3 ms, p95 48.5 ms
PERF-10 linear-10k full, 3 runs: p50 87.2 ms, p95 98.6 ms
```

Les entrées `PERF-07`/`PERF-10` sont dans `crates/bench/baselines/ci.json`
avec des budgets absolus (60/100 ms et 150/250 ms).

## 3. Écarts et risques

| Élément | État | Suite |
|---|---|---|
| P1-T14 dogfooding humain | non exécuté | appliquer `docs/reviews/p1-dogfooding.md` |
| `--all-reduced --assert` | PERF-05/06 dépassent la baseline sur cette machine (facteur machine, code inchangé) | recalibrer la baseline sur l'agent CI avant blocage, comme prévu par B-04 |
| Annulation sync | chemin implémenté (SIGTERM + revalidation) ; pas de test déterministe de réseau bloquant | ajouter un faux helper Git lent en CI |
| Credential helper HTTPS | délégation aux helpers Git/config SSH existants, aucun token en URL/argv | helper applicatif keychain si un besoin réel est mesuré |
| MR GitLab réelle | contrat HTTP complet + wiremock ; instance live P0 déjà validée | exécuter le parcours création sur projet de test |

## 4. Décision

- **GO** pour utiliser P1 sur des dépôts réels hors opérations P2.
- **NO-GO** pour déclarer le critère de sortie humain P1-T14 satisfait sans les
  trois développeurs prévus.
