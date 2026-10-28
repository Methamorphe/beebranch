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

   Si la CI est indisponible (quota Actions épuisé, facturation en échec),
   publier depuis le poste : voir « Publication locale (sans CI) » plus bas.

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

## Publication locale (sans CI)

Le pipeline n'est pas indispensable : la publication se fait depuis le poste qui
détient les clés, avec `gh` authentifié. Utile quand le quota Actions est épuisé
ou pour une plateforme isolée.

Les credentials vivent dans `.env` (ignoré par git, modèle dans `.env.example`) :
identité de signature macOS, Key ID + Issuer ID + chemin du `.p8` de
notarisation, chemins de la clé minisign et de son mot de passe, endpoint de
mise à jour. `npm run release:build` les exporte puis lance `tauri build` :

```sh
cp .env.example .env   # une fois, puis renseigner les valeurs
npm run release:build  # signe l'app, la notarie et l'agraphe, signe l'update
```

Le script refuse de builder si une variable, la clé de notarisation ou la clé
minisign manque. Les secrets eux-mêmes ne sont jamais recopiés dans `.env` :
il ne contient que les chemins des fichiers de clé, dont le contenu est lu au
moment du build.

Notarisation et publication du DMG (Tauri notarie et agraphe l'app ; le DMG est
soumis séparément) :

```sh
set -a; . ./.env; set +a
DMG="target/release/bundle/dmg/BeeBranch_<version>_aarch64.dmg"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

node scripts/update-manifest.mjs --dir target/release/bundle --target darwin-aarch64 \
  --version <version> --notes "docs/releases/<version>.md" \
  --base-url "https://github.com/Methamorphe/beebranch-releases/releases/download/v<version>" \
  --out target/update/fragments/darwin-aarch64.json
node scripts/merge-manifests.mjs --dir target/update/fragments --version <version> \
  --notes "docs/releases/<version>.md" --out target/update/latest.json
```

Rollback : à partir de la deuxième release, télécharger le manifeste publié
précédent (`gh release download <version-precedente> --repo Methamorphe/beebranch-releases --pattern latest.json --dir target/update/previous`) et ajouter
`--rollback target/update/previous/latest.json` à `merge-manifests.mjs`.

Publication et contrôle :

```sh
gh release create "v<version>" --repo Methamorphe/beebranch-releases \
  --title "BeeBranch <version>" --notes-file "docs/releases/<version>.md" \
  target/update/latest.json target/update/rollback.json \
  target/release/bundle/macos/BeeBranch.app.tar.gz \
  target/release/bundle/macos/BeeBranch.app.tar.gz.sig \
  target/release/bundle/dmg/BeeBranch_<version>_aarch64.dmg

curl -sSL "https://github.com/Methamorphe/beebranch-releases/releases/latest/download/latest.json"
```

Le tag `v<version>` n'est nécessaire que pour déclencher la CI ; en publication
locale il ne sert que de repère. Une release publiée en `--draft` ou
`--prerelease` ne devient pas `latest` et n'est donc jamais servie aux clients.

## Secrets requis

| Secret | Usage |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contenu de `src-tauri/keys/release.key` (clé privée minisign) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | mot de passe de `release.key` |
| `RELEASE_REPO_TOKEN` | PAT fine-grained, `Contents: Read and write` sur `Methamorphe/beebranch-releases` uniquement — **nécessaire seulement pour publier depuis la CI** (une publication locale utilise l'auth `gh` du poste) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | signature macOS : `.p12` **Developer ID Application** en base64, son mot de passe, et l'identité exacte (`security find-identity -v -p codesigning`) |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | notarisation via clé API App Store Connect (recommandé) : Key ID, Issuer ID, contenu du `.p8`. La CI écrit le fichier et exporte `APPLE_API_KEY_PATH`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | alternative de notarisation via Apple ID (`APPLE_PASSWORD` = mot de passe d'application) |
| `TAURI_WINDOWS_CERTIFICATE`, `TAURI_WINDOWS_CERTIFICATE_PASSWORD` | signature Authenticode Windows (optionnel : sans eux, installateur non signé) |

Sans certificat, la CI produit un bundle non signé (avertissement) et conserve la
signature d'update. Avec un certificat, les credentials de notarisation sont
obligatoires : `spctl --assess` échouerait sur un binaire non notarié.

### Notarisation macOS (clé API App Store Connect)

Prérequis : compte Apple Developer payant ; rôle **Account Holder** ou **Admin**
pour créer la clé.

1. App Store Connect → **Users and Access** → **Integrations** → **Team Keys** →
   **+**. Nom libre, accès **Developer**, puis *Generate*.
2. Relever l'**Issuer ID** (UUID affiché au-dessus du tableau) et le **Key ID**
   (10 caractères, colonne *Key ID*).
3. Télécharger la clé privée `AuthKey_<Key ID>.p8` : le téléchargement n'est
   proposé **qu'une seule fois**. La conserver hors du dépôt.
4. Valider les credentials sans soumettre de build :

   ```sh
   xcrun notarytool history \
     --key AuthKey_<Key ID>.p8 --key-id <Key ID> --issuer <Issuer ID>
   ```

5. Poser les secrets GitHub (le `.p8` est multiligne, `gh secret set` lit stdin) :

   ```sh
   gh secret set APPLE_API_KEY --body "<Key ID>"
   gh secret set APPLE_API_ISSUER --body "<Issuer ID>"
   gh secret set APPLE_API_KEY_P8 < AuthKey_<Key ID>.p8
   ```

Le certificat de signature reste distinct : il faut un **Developer ID
Application** (Certificates → + → *Developer ID Application*), exporté en `.p12`
avec sa clé privée, puis encodé en base64 pour `APPLE_CERTIFICATE`. Un certificat
*Apple Distribution* ne convient pas à une distribution hors App Store.

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
