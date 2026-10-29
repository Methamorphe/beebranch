## Problème

<!-- Comportement observé, cause identifiée, issue liée. -->

## Changement

<!-- Ce qui change, et pourquoi cette solution plutôt qu'une autre. -->

## Périmètre

- [ ] Chaque commit est signé DCO (`git commit -s`).
- [ ] Une seule préoccupation ; aucun refactor non lié.
- [ ] Aucune nouvelle abstraction sans besoin démontré.
- [ ] Aucun secret, token, clé ou fichier `.env` ajouté.

## Vérifications

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `npm run ui:smoke` (si l'interface change)
- [ ] `npm run audit:telemetry`

Preuve d'exécution réelle (sortie, capture, scénario rejoué) :

<!-- Collez la preuve. Une fonctionnalité n'est pas terminée parce que l'UI existe. -->

## Risques et limites

<!-- Ce qui n'est pas couvert, les hypothèses restantes, les plateformes non testées. -->
