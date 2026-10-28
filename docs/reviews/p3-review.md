# P3 — Revue d'implémentation

**Date :** 2026-10-27
**Version :** 0.4.0
**Périmètre :** P3-T01 → P3-T07 + distribution signée.

## Résultat

Les sept fiches P3 sont implémentées et vérifiées par des tests Rust réels, un
smoke UI étendu (113 contrôles) et des benchmarks avant/après. Les preuves
d'exécution sont listées en fin de document.

## Preuves par fiche

| Fiche | Implémentation | Tests / preuve |
|---|---|---|
| P3-T01 Undo / redo | `crates/git/src/undo.rs`, `crates/store/src/undo.rs`, `crates/app/src/commands/undo.rs`, `src/components/RecoveryPanel.tsx`, boutons RepoBar, raccourcis `Mod+Z`/`Mod+Shift+Z` | `crates/git/tests/undo.rs` (14 scénarios : commit, amend, checkout, branches, tags, remotes, stash, worktrees, merge conflictuel/terminé, empreinte, échec partiel, aucune copie), `crates/app/tests/undo.rs` (pipeline, refus de précondition, crash), `crates/store/src/undo.rs` (pile bornée, redo invalidé, reprise) |
| P3-T02 Drag & drop | `crates/git/src/integration.rs`, `branch_integration_preview/start`, `BranchesPanel` (drag + aperçu + confirmation), `RebasePanel` (réordonnancement drag) | `crates/git/tests/integration.rs` (merge cohérent, conflit + abort, rebase, blocages), smoke : `branch-drag-rows`, `drop-preview-shows-commits`, `drop-no-mutation-before-confirm`, `drop-cancel-no-mutation`, `drop-confirm-calls-integration`, `rebase-drag-reorders-preview`, `rebase-drag-no-mutation-before-start` |
| P3-T03 Design system | `src/styles/tokens.css` (espacement, typage, profondeur, mouvement, densité), `src/components/ui/Button.tsx`, `Dialog.tsx`, animations `view-enter`, préférence de densité | Smoke : contrastes sombre/clair, `density-compact-tokens`, `density-restored`, captures `p3-density-compact.png`, `p3-light.png`, `p3-branch-drop.png`, `p3-workspaces.png`, `p3-updates.png` |
| P3-T04 Gros dépôts | `LogStream` dans `crates/git/src/log.rs` + `RepoSession`, curseur `index:sha`, fallback `--skip` uniquement non séquentiel | `cursor_pages_reconstruct_*`, `session_graph_stream_pages_match_the_full_log`, bench PERF-03 : `linear-1m` 38,6 s → 18 ms, baseline mise à jour |
| P3-T05 Workspaces | `crates/store/src/workspaces.rs`, `crates/app/src/commands/workspaces.rs`, `src/components/WorkspacesPanel.tsx` | `crates/app/tests/workspaces.rs` : 10 dépôts, échec isolé, sessions fermées, pull propre/sale, store ; smoke : statut par dépôt, borne 20, échec partiel |
| P3-T06 Accessibilité | lien d'évitement, `main#main-content`, Dialog unique avec piège/restauration du focus, contrastes, rôles/libellés, annonces, navigation clavier | Smoke : `a11y-workspaces`, `a11y-graph`, `a11y-profiles`, `skip-link`, `skip-link-target`, contrastes tokens, scénarios clavier/focus existants (palette, dialogues, canvas, menus) |
| P3-T07 Distribution | `src-tauri/tauri.conf.json` (packaging, updater, signatures), `src-tauri/entitlements.plist`, `crates/app/src/commands/update.rs`, `ProfilesPanel`, `.github/workflows/release.yml`, `scripts/update-manifest.mjs`, `merge-manifests.mjs`, `audit-no-telemetry.mjs`, notes de version | `crates/app/tests/update_signature.rs` (artefact signé accepté, altéré/absent refusé), smoke : paramètres de mise à jour signée + absence de télémétrie, audit télémetry, manifestes latest/rollback générés |

## Garanties vérifiées

- Aucune opération irréversible (discard, reset --hard, stash drop/apply/pop,
  fetch, push, submodule update) n'est proposée à l'undo ; un `reset --hard`
  inverse n'est utilisé qu'après égalité d'empreinte.
- Un fichier non suivi n'est jamais supprimé par un undo.
- Un échec partiel conserve l'étape, la commande et le SHA de récupération ;
  une restauration interrompue n'est pas rejouée au démarrage.
- Un drop branche ne mute rien avant confirmation ; l'annulation ne change
  rien ; les conflits restent visibles.
- Le graphe ne parcourt plus le préfixe pour les pages profondes ; un
  processus `git log` par session est annulé à la fermeture.
- Un workspace rapporte un résultat par dépôt et ferme les sessions ouvertes
  pour l'action.
- Les contrastes sont ≥ 7:1 pour le texte, ≥ 4,5:1 pour le texte secondaire
  et ≥ 3:1 pour les lanes, dans les deux thèmes.
- Une mise à jour non signée ou altérée est refusée ; le rollback utilise le
  même contrôle de signature.

## Commandes exécutées

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build
npm run lint
npm run ui:smoke
node scripts/audit-no-telemetry.mjs
target/release/beebranch-bench --all-reduced --assert
```

## Résultats d'exécution

- `cargo fmt --all -- --check` : conforme.
- `cargo clippy --workspace --all-targets -- -D warnings` : 0 avertissement.
- `cargo test --workspace` : 351 tests, 0 échec.
- `npm run build` : TypeScript + Vite OK.
- `npm run lint` : 0 erreur (avertissements `set-state-in-effect` hérités).
- `npm run ui:smoke` : `ok: true`, 113 contrôles UX P1/P2/P3 verts —
  sortie [p3-smoke.json](p3-smoke.json), captures
  [p3-workspaces.png](p3-workspaces.png),
  [p3-branch-drop.png](p3-branch-drop.png),
  [p3-updates.png](p3-updates.png),
  [p3-density-compact.png](p3-density-compact.png),
  [p3-light.png](p3-light.png).
- `node scripts/audit-no-telemetry.mjs` : aucune référence.
- `target/release/beebranch-bench --all-reduced --assert` : set réduit sous
  ses budgets ; PERF-03 30,46 ms p50 (baseline mise à jour).
- Manifestes : `latest.json` et `rollback.json` générés à partir d'artefacts
  `.sig` ; signature minisign altérée refusée par test.

## Limites connues

- L'installation sur machine propre et la notarisation réelle dépendent des
  secrets et runners de la CI ; elles ne sont pas reproductibles dans cet
  environnement. La CI de release vérifie la signature de chaque plateforme.
- Le rollback exige qu'une version précédente signée soit encore publiée sur
  l'endpoint `rollback.json`.
- Le dogfooding humain multi-profils reste à planifier.
- Les tests sont exécutés sur macOS ; les chemins Windows/Linux sont couverts
  par la CI et la conception, pas par une exécution locale.
