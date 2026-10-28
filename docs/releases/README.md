# Processus de release

1. Mettre à jour la version dans `Cargo.toml` (workspace), `package.json` et
   `src-tauri/tauri.conf.json`.
2. Ajouter `docs/releases/<version>.md` (notes publiées dans le manifeste et
   dans GitHub Releases).
3. Vérifier localement : `cargo fmt --all -- --check`,
   `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `npm run build`, `npm run lint`,
   `npm run ui:smoke`, `npm run audit:telemetry`.
4. Pousser un tag `v<version>`. La CI `release.yml` :
   - construit sur macOS, Linux et Windows ;
   - signe et notarise macOS, signe les installateurs Windows ;
   - vérifie la signature de chaque plateforme ;
   - installe le paquet sur un runner propre et exécute `BeeBranch --version` ;
   - génère un fragment `latest.json` par plateforme ;
   - fusionne les fragments, génère `latest.json` et `rollback.json` ;
   - publie les artefacts signés et les manifestes.

## Hébergement des manifestes (dépôt public `beebranch-releases`)

Le code source reste privé. Le job `publish` publie dans
`Methamorphe/beebranch-releases` (public) `latest.json`, `rollback.json` et les
artefacts signés. L'application interroge une URL stable, sans serveur dédié :

| Manifeste | URL |
|---|---|
| mise à jour | `https://github.com/Methamorphe/beebranch-releases/releases/latest/download/latest.json` |
| rollback | `https://github.com/Methamorphe/beebranch-releases/releases/latest/download/rollback.json` |

L'URL est injectée à la compilation par `BEEBRANCH_UPDATE_ENDPOINT` (voir le
job `build` de `release.yml`, variable `RELEASES_REPO`) ; elle sert à la fois à
l'affichage dans Réglages → Mises à jour, à la vérification, au téléchargement
et au rollback. Le repli des compilations locales est
`DEFAULT_UPDATE_ENDPOINT` dans `crates/app/src/commands/update.rs`.

Contraintes :

| Contrainte | Détail |
|---|---|
| Cross-repo | Publier dans un autre dépôt exige `RELEASE_REPO_TOKEN` (PAT fine-grained, `Contents: Read and write` sur `beebranch-releases` uniquement). Sans ce secret, le job `publish` échoue immédiatement avec un message explicite. |
| `latest` | GitHub renvoie la release la plus récemment **créée**, hors brouillon et hors pré-release. Ne jamais publier une mise à jour en `--draft` ou `--prerelease`. |
| Historique | Les URLs d'artefacts sont immuables (`/releases/download/<tag>/…`) : ne pas supprimer la release N-1, sinon `rollback.json` pointe dans le vide. |
| HTTPS | Un endpoint non HTTPS est refusé (`update.invalid_endpoint`), sauf loopback pour tester un manifeste local. |
| Panne | GitHub indisponible ⇒ `update.timeout` / `update.failed` ; aucune installation n'est tentée. |
| Signature Apple/Windows | Optionnelle : sans les secrets `APPLE_*` / `TAURI_WINDOWS_CERTIFICATE`, la CI construit un bundle non signé par l'OS (avertissement, Gatekeeper/SmartScreen) mais conserve la signature d'update obligatoire. |
| Matrice | `macos-latest` est arm64 : seul `darwin-aarch64` est publié (pas de build Intel), plus `linux-x86_64` et `windows-x86_64`. |

La signature minisign reste la barrière : compromettre le dépôt public ou l'URL
ne suffit pas à installer un binaire non signé.

## Secrets requis

| Secret | Usage |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contenu de `src-tauri/keys/release.key` (clé privée minisign) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | mot de passe de `release.key` |
| `RELEASE_REPO_TOKEN` | PAT fine-grained, `Contents: Read and write` sur `Methamorphe/beebranch-releases` uniquement — publication cross-repo |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | signature et notarisation macOS (optionnel : sans eux, bundle non signé) |
| `TAURI_WINDOWS_CERTIFICATE`, `TAURI_WINDOWS_CERTIFICATE_PASSWORD` | signature Authenticode Windows (optionnel : sans eux, installateur non signé) |

La clé publique `release.key.pub` est embarquée dans
`src-tauri/tauri.conf.json`. Ne jamais publier la clé privée.

## Rollback

La release conserve `rollback.json` pointant la version précédente. Si une
version est défectueuse, l'utilisateur peut installer la précédente depuis
Réglages → Mises à jour → « Revenir à la version précédente ». Le même contrôle
de signature s'applique.

## Rotation de la clé de signature

1. `node_modules/.bin/tauri signer generate -w src-tauri/keys/release.key -f`
   avec un mot de passe neuf, stocké dans `src-tauri/keys/release.key.password`
   (ignoré par git, comme `*.key`).
2. Recopier le contenu de `release.key.pub` dans `plugins.updater.pubkey` de
   `src-tauri/tauri.conf.json`.
3. Réécrire les secrets `TAURI_SIGNING_PRIVATE_KEY` et
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Publier une release : la CI signe avec la nouvelle clé.

Un client installé ne vérifie qu'avec **la clé embarquée dans sa propre
version** : après une rotation, l'ancienne version ne peut plus installer les
nouvelles releases (elle les refuse en `update.signature_invalid`). La rotation
se prépare donc avec une release de transition signée par l'ancienne clé, ou un
téléchargement manuel.



## Aucune télémétrie

`npm run audit:telemetry` échoue si une référence d'analytics apparaît dans
les sources applicatives. Seuls GitLab, Git et l'endpoint de mise à jour sont
contactés, sur action de l'utilisateur.
