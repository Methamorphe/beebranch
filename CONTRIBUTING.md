# Contribuer à BeeBranch

Merci de contribuer. Ce dépôt suit des règles strictes de périmètre et de
preuve : une contribution est acceptée quand elle résout le problème posé, avec
des tests et une démonstration d'exécution réelle.

## Environnement

Prérequis : Rust ≥ 1.85, Node ≥ 22, Git ≥ 2.34, dépendances système
[Tauri 2](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

## Règles de périmètre

1. Une contribution = un problème fermé, une branche, une PR.
2. Ne pas élargir le périmètre : toute fonctionnalité non demandée est hors
   scope.
3. Ne pas introduire d'abstraction non demandée (trait de backend Git, système
   de plugins, provider générique).
4. Une fonctionnalité n'est **pas** terminée parce que l'UI existe : critères
   d'acceptation + tests + preuve d'exécution réelle.
5. Toute affirmation de performance doit être accompagnée d'une mesure
   reproductible (`cargo run -p beebranch-bench --release -- …`).
6. Toute hypothèse non vérifiée reste marquée `[HYPOTHÈSE]` dans le code, les
   tests ou la doc.
7. Le travail non lié (renommage global, reformatage, mise à jour de dépendances
   sans rapport) doit être une PR séparée.

## Vérifications avant PR

```bash
npm run lint
npm run build
npm run audit:telemetry
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Pour un changement d'interface, ajoutez ou exécutez le test headless :

```bash
npm run ui:smoke
```

La CI rejoue ces commandes sur Linux, macOS et Windows. Une PR qui échoue sur
`clippy -D warnings`, `cargo fmt` ou la suite de tests n'est pas fusionnée.

## Tests

- Bug : reproduire avant, corriger, vérifier après. Une régression sans test
  doit être justifiée dans la PR.
- Les tests doivent couvrir un comportement visible (frontières, invariants,
  erreurs, précédence), pas la plomberie ni les valeurs par défaut.
- Les tests d'interface ne remplacent pas une vérification manuelle du parcours
  concerné.

## Commits et PR

- **Tout commit doit être signé DCO 1.1** : ajoutez `Signed-off-by` avec
  `git commit -s`. La CI (`dco.yml`, via `scripts/check-dco.sh`) rejette un
  commit dont le trailer manque ou dont l'adresse diffère de celle de l'auteur.
- Messages au format `type(scope): description` (`fix(release): …`,
  `chore(release): …`, `feat(graph): …`), en français ou en anglais, sans
  emoji.
- Décrivez le problème, la cause, la correction et les vérifications exécutées.
- Ne committez jamais de secret : clés minisign, certificat Apple, token GitLab
  ou GitHub, fichier `.env`. Voir [SECURITY.md](SECURITY.md).
- Les releases et la version sont gérées par les mainteneurs ; ne modifiez pas
  `Cargo.toml`/`package.json`/`tauri.conf.json` pour une autre raison.

## Documentation

Toute décision structurante doit être consignée dans `docs/adr/`. Toute
affirmation de performance ou de sécurité doit renvoyer à une preuve
reproductible.

## Licence des contributions

Chaque commit porte une signature [DCO 1.1](https://developercertificate.org/) :
vous certifiez avoir le droit de soumettre le code et acceptez qu'il soit
distribué sous [AGPL-3.0-only](LICENSE), sans conditions supplémentaires.
