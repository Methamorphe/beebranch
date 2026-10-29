# Passage en public — checklist mainteneur

Cette checklist décrit les opérations **restantes** pour rendre le dépôt public
et activer le workflow de contribution par merge request. Les éléments de
licence, de gouvernance, de CI et d'historique sont déjà en place.

## 1. Avant de basculer

- [ ] Vérifier qu'aucun travail en cours ne contient de secret :
      `git status --ignored`, puis `git log --all -p | grep -Ei 'BEGIN .*PRIVATE KEY|gh[pousr]_|glpat-|AKIA'`.
- [ ] Vérifier que `src-tauri/keys/` et `.env` restent locaux (ignorés).
- [ ] Vérifier que l'historique ne contient plus l'adresse professionnelle :
      `git log --all --format='%ae%n%ce' | sort -u`.
- [ ] Confirmer le titulaire du copyright (LICENSE : `Methamorphe`) et la
      licence AGPL-3.0-only auprès de l'employeur si le code a été produit dans
      un cadre salarié.
- [ ] Vérifier les marques et assets : le logo et la palette ne sont pas
      couverts par la licence du code (voir README).

## 2. Basculer en public

```bash
gh repo edit Methamorphe/beebranch \
  --visibility public \
  --accept-visibility-change-consequences
```

## 3. Appliquer la protection et la sécurité

```bash
scripts/setup-github-protection.sh Methamorphe/beebranch
```

Le script est idempotent. Il crée :

- un ruleset sur `main` : merge request obligatoire, une approbation, revue
  CODEOWNERS, conversations résolues, branche à jour, checks `Frontend`,
  `Rust (ubuntu|macos|windows-latest)` et `DCO`, historique linéaire, pas de
  force-push ni de suppression ; bypass administrateur pour les urgences ;
- un ruleset sur les tags `v*` : suppression, mise à jour et force-push
  interdits ;
- le signalement privé de vulnérabilités, les alertes Dependabot, les
  correctifs automatiques, le secret scanning et la protection des push.

Vérifier ensuite dans **Settings → Rules → Rulesets** que les deux rulesets sont
actifs, et dans **Security** que le secret scanning et les advisories privées
sont activés.

## 4. Vérifier le workflow de contribution

- [ ] Ouvrir une merge request de test depuis un fork : la CI `Frontend`,
      `Rust`, `DCO` et `Dependency review` doit s'exécuter.
- [ ] Vérifier qu'un commit sans `Signed-off-by` échoue sur `DCO`.
- [ ] Vérifier qu'un push direct sur `main` est refusé.
- [ ] Vérifier que le bouton de merge propose uniquement le squash.

## 5. Première release publique

Le workflow `release.yml` publie désormais dans les releases du dépôt source
(`Methamorphe/beebranch`), avec `GITHUB_TOKEN` et `contents: write`.

> **Compatibilité des clients existants** : les versions ≤ 0.7.2 compilent
> l'endpoint `Methamorphe/beebranch-releases`. Tant que ces versions sont
> supportées, publier aussi `latest.json` et `rollback.json` dans ce dépôt
> miroir, ou conserver le miroir comme source de mise à jour. Sinon, ces clients
> ne verront jamais la release publiée dans le dépôt source.

- [ ] Pousser un tag `v<version>` après avoir mis à jour les trois versions.
- [ ] Vérifier que `latest.json` et `rollback.json` sont attachés à la release.
- [ ] Vérifier la signature minisign et l'installation sur une machine propre.
- [ ] Vérifier que l'URL `.../releases/latest/download/latest.json` répond.

## 6. Après publication

- [ ] Épingler l'issue de bienvenue et les discussions de roadmap si activées.
- [ ] Surveiller les advisories privées et les alertes Dependabot.
- [ ] Ne jamais supprimer la release N-1 : `rollback.json` en dépend.
