# ADR-0009 — Mises à jour signées et rollback

**Statut :** accepté
**Date :** 2026-10-27

## Contexte

BeeBranch est distribué hors magasin d'applications. Une mise à jour doit être
authentifiée, installable sur Windows/macOS/Linux, et réversible sans
transformer l'application en service cloud.

## Décision

1. Le mécanisme est `tauri-plugin-updater` avec des artefacts minisign.
2. La clé publique est embarquée dans `tauri.conf.json` ; la clé privée ne
   quitte jamais les secrets de la CI.
3. `latest.json` annonce la version courante ; `rollback.json` pointe la
   version précédente encore publiée. Les deux manifestes référencent des
   artefacts signés.
4. La vérification de signature est faite par le plugin **avant** toute
   installation. Une signature absente, invalide ou liée à une autre version
   est refusée (`update.signature_invalid`).
5. Le rollback est une installation signée de la version précédente, avec une
   confirmation explicite ; ce n'est pas une copie de sauvegarde locale.
6. Aucune télémétrie : l'application n'envoie que les requêtes GitLab/Git
   demandées par l'utilisateur et la requête de manifeste lors d'une
   vérification de mise à jour.
7. Le packaging et les vérifications de signature sont exécutés par la CI de
   release, sur les trois OS.

## Alternatives considérées

- Mise à jour manuelle par téléchargement : pas de vérification
  cryptographique native, rollback non outillé.
- Serveur de mise à jour maison avec base de données : surface cloud inutile.
- Copie locale de l'ancien bundle pour rollback : coût disque, risque de
  restaurer un binaire non signé, contraire à la règle « signature d'abord ».

## Conséquences

- Les releases doivent conserver au moins la version précédente et son
  manifeste.
- La CI doit disposer des secrets de signature et, pour macOS, des secrets de
  notarisation.
- Un endpoint compromis ne suffit pas à installer un binaire arbitraire : la
  signature reste la barrière.

## Amendement — 2026-10-28

L'hébergement des manifestes est GitHub Releases : l'endpoint compilé est
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`,
injecté par la CI via `BEEBRANCH_UPDATE_ENDPOINT`. Aucun serveur maison n'est
nécessaire ; `updates.beebranch.fr` ne reste que le repli des compilations
locales. Conséquence ajoutée : le dépôt qui porte les releases doit être lisible
par les utilisateurs, et la release N-1 ne doit pas être supprimée.
