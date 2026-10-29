# ADR-0009 — Signed updates and rollback

**Status:** accepted
**Date:** 2026-10-27

## Context

BeeBranch is distributed outside app stores. An update must be
authenticated, installable on Windows/macOS/Linux, and reversible without
turning the application into a cloud service.

## Decision

1. The mechanism is `tauri-plugin-updater` with minisign artifacts.
2. The public key is embedded in `tauri.conf.json`; the private key never
   leaves CI secrets.
3. `latest.json` announces the current version; `rollback.json` points to the
   previous version still published. Both manifests reference
   signed artifacts.
4. Signature verification is performed by the plugin **before** any
   installation. A missing, invalid, or different-version signature
   is rejected (`update.signature_invalid`).
5. Rollback is a signed installation of the previous version, with
   explicit confirmation; it is not a local backup copy.
6. No telemetry: the application sends only the GitLab/Git requests
   requested by the user and the manifest request during an
   update check.
7. Packaging and signature checks are performed by release CI,
   on all three OSes.

## Alternatives considered

- Manual update by download: no native cryptographic
  verification, no rollback tooling.
- In-house update server with a database: unnecessary cloud surface.
- Local copy of the old bundle for rollback: disk cost, risk of
  restoring an unsigned binary, contrary to the “signature first” rule.

## Consequences

- Releases must retain at least the previous version and its
  manifest.
- CI must have signing secrets and, for macOS, notarization
  secrets.
- A compromised endpoint is not enough to install an arbitrary binary: the
  signature remains the barrier.

## Amendment — 2026-10-28

Manifests are hosted on GitHub Releases, in the public repository
`Methamorphe/beebranch`, which also holds the source code: the compiled endpoint is
`https://github.com/Methamorphe/beebranch/releases/latest/download/latest.json`,
injected by CI via `BEEBRANCH_UPDATE_ENDPOINT`. The `publish` job creates the
release with the Actions `GITHUB_TOKEN` and the `contents: write` permission;
no PAT or mirror repository is needed. No in-house server is
needed, and the same URL serves as a fallback for local builds. Added
consequences: release N-1 must not be deleted, and a build not signed by
the OS (Apple/Windows secrets absent) is still published with an explicit
warning — the update signature itself is never optional.
