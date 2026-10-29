# Release process

1. On `dev`, update the version in `Cargo.toml` (workspace), `package.json` and
   `src-tauri/tauri.conf.json`.
2. Add `docs/releases/<version>.md` (notes published in the manifest and
   in GitHub Releases).
3. Verify locally: `cargo fmt --all -- --check`,
   `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `npm run build`, `npm run lint`,
   `npm run ui:smoke`, `npm run audit:telemetry`.
4. Open a PR **`dev` → `main`**, then merge it after validation.
   The push to `main` triggers `ci`. After it succeeds, `release.yml` uses
   exactly the validated commit, creates the tag `v<version>` if it does not exist, then:
   - builds on macOS, Linux and Windows;
   - signs and notarizes macOS, signs the Windows installers;
   - verifies each platform's signature;
   - installs the package on a clean runner and runs `BeeBranch --version`;
   - generates a `latest.json` fragment per platform;
   - merges the fragments, generates `latest.json` and `rollback.json`;
   - publishes the signed artifacts and manifests.

   If CI is unavailable (Actions quota exhausted, billing failure),
   publish from the workstation: see “Local publishing (without CI)” below.

Pushes to `dev` trigger neither CI nor a release; PRs targeting `dev` and `main`
remain checked. An existing tag prevents any new automatic publication
of that version (including `1.0.0`). Do not push a tag to
trigger a release: tag `push` events are no longer monitored.
If a failure occurs after the tag is created, run `release.yml` manually
**from `main`**, with the existing tag.
A manual run rejects a tag whose commit does not belong to `main`
or whose name does not match the version in the targeted `package.json`.


## Manifest hosting (main repository)

The source code and releases live in the same public repository. The
`publish` job creates the `Methamorphe/beebranch` release with `latest.json`,
`rollback.json` and the signed artifacts. The application queries a stable
URL, without a dedicated server:

| Manifest | URL |
|---|---|
| update | `https://github.com/Methamorphe/beebranch/releases/latest/download/latest.json` |
| rollback | `https://github.com/Methamorphe/beebranch/releases/latest/download/rollback.json` |

The URL is injected at compile time by `BEEBRANCH_UPDATE_ENDPOINT` (see the
`build` job in `release.yml`, `github.repository`); it is used for display
in Settings → Updates, checking, downloading
and rollback. The fallback for local builds is
`DEFAULT_UPDATE_ENDPOINT` in `crates/app/src/commands/update.rs`, and points
to the same URL.

Constraints:

| Constraint | Detail |
|---|---|
| Permissions | The `publish` job uses the `GITHUB_TOKEN` provided by Actions and the `contents: write` permission declared in `release.yml`; no additional PAT is required. |
| `latest` | GitHub returns the most recently **created** release, excluding drafts and prereleases. Never publish an update with `--draft` or `--prerelease`. |
| History | Artifact URLs are immutable (`/releases/download/<tag>/…`): do not delete release N-1, or `rollback.json` will point nowhere. |
| HTTPS | A non-HTTPS endpoint is rejected (`update.invalid_endpoint`), except loopback for testing a local manifest. |
| Outage | GitHub unavailable ⇒ `update.timeout` / `update.failed`; no installation is attempted. |
| Apple/Windows signing | Optional: without the `APPLE_*` / `TAURI_WINDOWS_CERTIFICATE` secrets, CI builds a bundle without an OS signature (warning, Gatekeeper/SmartScreen) but retains the required update signature. |
| Matrix | `macos-latest` is arm64: only `darwin-aarch64` is published (no Intel build), plus `linux-x86_64` and `windows-x86_64`. |

The minisign signature remains the barrier: compromising the public repository or URL
is not enough to install an unsigned binary.

## Local publishing (without CI)

The pipeline is not essential: publishing runs from the workstation that
holds the keys, with `gh` authenticated. Useful when the Actions quota is exhausted
or for an isolated platform.

Credentials live in `.env` (ignored by git, template in `.env.example`):
macOS signing identity, Key ID + Issuer ID + path to the notarization
`.p8`, paths to the minisign key and its password, update
endpoint. `npm run release:build` exports them, then runs `tauri build`:

```sh
cp .env.example .env   # once, then fill in the values
npm run release:build  # signs the app, notarizes and staples it, signs the update
```

The script refuses to build if a variable, the notarization key or the
minisign key is missing. The secrets themselves are never copied into `.env`:
it contains only the paths to the key files, whose contents are read at
build time.

DMG notarization and publishing (Tauri notarizes and staples the app; the DMG is
submitted separately):

```sh
set -a; . ./.env; set +a
DMG="target/release/bundle/dmg/BeeBranch_<version>_aarch64.dmg"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

node scripts/update-manifest.mjs --dir target/release/bundle --target darwin-aarch64 \
  --version <version> --notes "docs/releases/<version>.md" \
  --base-url "https://github.com/Methamorphe/beebranch/releases/download/v<version>" \
  --out target/update/fragments/darwin-aarch64.json
node scripts/merge-manifests.mjs --dir target/update/fragments --version <version> \
  --notes "docs/releases/<version>.md" --out target/update/latest.json
```

Rollback: starting with the second release, download the previous published
manifest (`gh release download <version-previous> --repo Methamorphe/beebranch --pattern latest.json --dir target/update/previous`) and add
`--rollback target/update/previous/latest.json` to `merge-manifests.mjs`.

Publishing and checking:

```sh
gh release create "v<version>" --repo Methamorphe/beebranch \
  --title "BeeBranch <version>" --notes-file "docs/releases/<version>.md" \
  target/update/latest.json target/update/rollback.json \
  target/release/bundle/macos/BeeBranch.app.tar.gz \
  target/release/bundle/macos/BeeBranch.app.tar.gz.sig \
  target/release/bundle/dmg/BeeBranch_<version>_aarch64.dmg

curl -sSL "https://github.com/Methamorphe/beebranch/releases/latest/download/latest.json"
```

The tag `v<version>` is created automatically after CI validates `main`;
when publishing locally, create this marker on the `main` commit to publish.
A release published with `--draft` or `--prerelease` does not become `latest` and
is therefore never served to clients.

## Local Windows publishing (adding a missing platform)

When a release contains only macOS artifacts, the Windows bundle is
built on a Windows machine with `scripts/release-windows.ps1`: it
checks that HEAD is indeed the tag and that `tauri.conf.json`, `package.json` and
`Cargo.toml` report the same version, compiles with the release endpoint and the
minisign key, checks the signature against the key **embedded** in
`tauri.conf.json` (`scripts/verify-update-signature.mjs`), installs the package
silently and runs `BeeBranch --version`, rebuilds `latest.json` while preserving
the already published darwin/linux entries, then uploads the artifacts **before** the
manifest to `Methamorphe/beebranch`.

Prerequisites: Node 22, Rust MSVC (Visual Studio Build Tools, C++
workload), `gh` authenticated with write access to `Methamorphe/beebranch`, and
`src-tauri/keys/release.key` + `release.key.password` copied outside git — to be
removed from the machine after use.

Windows update artifact: `bundle.createUpdaterArtifacts` is `true` in
v2 configuration, so the NSIS installer **is** the update artifact and its
signature is named `BeeBranch_<version>_x64-setup.exe.sig` — there is no
`*.nsis.zip` (that `*.zip` exists only with `"v1Compatible"`). The
`windows-x86_64` manifest therefore points to the `.exe` itself. If the signature is missing,
`TAURI_SIGNING_PRIVATE_KEY` was not set during the build:
rerun without `-SkipBuild` in the same PowerShell session.

```powershell
git clone git@github.com:Methamorphe/beebranch.git C:\src\beebranch
cd C:\src\beebranch
git checkout v0.6.2
.\scripts\release-windows.ps1 -Version 0.6.2
```

| Option | Effect |
|---|---|
| `-Version <v>` | version to add the platform to (default: the one in `tauri.conf.json`) |
| `-NoUpload` | stops after the manifest and displays the `gh` commands |
| `-SkipSmoke` | skips silent installation and `--version` |
| `-SkipBuild` | reuses the existing `target/release/bundle` |
| `-AllowVersionMismatch` | publishes a Windows-only manifest when the published manifest has a different version |
| `-SkipCleanCheck` | allows a dirty tree (the binary then no longer matches the tag) |

The script refuses to publish a `latest.json` that would not point to the new
artifact or whose signature would not match the embedded key.
`rollback.json` is never modified.

## Required secrets

| Secret | Usage |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `src-tauri/keys/release.key` (minisign private key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for `release.key` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | macOS signing: base64-encoded **Developer ID Application** `.p12`, its password, and the exact identity (`security find-identity -v -p codesigning`) |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | notarization via an App Store Connect API key (recommended): Key ID, Issuer ID, contents of the `.p8`. CI writes the file and exports `APPLE_API_KEY_PATH`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | alternative notarization via Apple ID (`APPLE_PASSWORD` = app-specific password) |
| `TAURI_WINDOWS_CERTIFICATE`, `TAURI_WINDOWS_CERTIFICATE_PASSWORD` | Windows Authenticode signing (optional: unsigned installer without them) |

Without a certificate, CI produces an unsigned bundle (warning) and retains the
update signature. With a certificate, notarization credentials are
required: `spctl --assess` would fail on a non-notarized binary.

### macOS notarization (App Store Connect API key)

Prerequisites: paid Apple Developer account; **Account Holder** or **Admin** role
to create the key.

1. App Store Connect → **Users and Access** → **Integrations** → **Team Keys** →
   **+**. Any name, **Developer** access, then *Generate*.
2. Note the **Issuer ID** (UUID displayed above the table) and the **Key ID**
   (10 characters, *Key ID* column).
3. Download the private key `AuthKey_<Key ID>.p8`: the download is
   offered **only once**. Keep it outside the repository.
4. Validate the credentials without submitting a build:

   ```sh
   xcrun notarytool history \
     --key AuthKey_<Key ID>.p8 --key-id <Key ID> --issuer <Issuer ID>
   ```

5. Set the GitHub secrets (the `.p8` is multiline, `gh secret set` reads stdin):

   ```sh
   gh secret set APPLE_API_KEY --body "<Key ID>"
   gh secret set APPLE_API_ISSUER --body "<Issuer ID>"
   gh secret set APPLE_API_KEY_P8 < AuthKey_<Key ID>.p8
   ```

The signing certificate remains separate: a **Developer ID
Application** is required (Certificates → + → *Developer ID Application*), exported as `.p12`
with its private key, then base64-encoded for `APPLE_CERTIFICATE`. An
*Apple Distribution* certificate is not suitable for distribution outside the App Store.

The public key `release.key.pub` is embedded in
`src-tauri/tauri.conf.json`. Never publish the private key.

## Rollback

The release retains `rollback.json` pointing to the previous version. If a
version is faulty, the user can install the previous one from
Settings → Updates → “Return to the previous version”. The same signature
check applies.

## Signing key rotation

1. `node_modules/.bin/tauri signer generate -w src-tauri/keys/release.key -f`
   with a new password, stored in `src-tauri/keys/release.key.password`
   (ignored by git, like `*.key`).
2. Copy the contents of `release.key.pub` into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json`.
3. Rewrite the `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.
4. Publish a release: CI signs with the new key.

An installed client verifies only with **the key embedded in its own
version**: after rotation, the old version can no longer install
new releases (it rejects them with `update.signature_invalid`). Rotation
therefore requires preparation with a transition release signed by the old key, or a
manual download.



## No telemetry

`npm run audit:telemetry` fails if an analytics reference appears in
the application sources. Only GitLab, Git and the update endpoint are
contacted, following a user action.
