# Security

## Supported versions

Security fixes are published on the latest stable version
(`vX.Y.Z` from [the latest release](https://github.com/Methamorphe/beebranch/releases/latest)).
Previous versions do not receive fixes; the update is signed and rollback is
available in the application.

## Reporting a vulnerability

Do **not** open a public issue for a vulnerability. Use GitHub's private
reporting:

<https://github.com/Methamorphe/beebranch/security/advisories/new>

Include: affected version, platform, minimal reproduction, observed impact,
and any evidence (output, screenshot, redacted log). Never attach a token, a
private key or real personal data.

Acknowledgement within 72 business hours. A fix is published with a signed
release; credit is added to the advisory unless requested otherwise.

## Threat model

| Asset | Control |
|---|---|
| GitLab/GitHub tokens | Stored in the OS keychain (`crates/store`), never in SQLite, the frontend, logs or diagnostics. Git and HTTP output is redacted (`crates/core/src/redaction.rs`). |
| Updates | Minisign artefacts verified by `tauri-plugin-updater` **before** installation; public key embedded in `tauri.conf.json`; endpoint served over HTTPS. A compromised repository or CDN is not enough to install an arbitrary binary. |
| Transport | Verified TLS for GitLab, GitHub and the update manifest; non-HTTPS endpoint refused outside loopback. |
| Git commands | The `git` CLI is invoked without a shell, with separate arguments (`crates/git`), to prevent command and argument injection. |
| Frontend | No secrets and no direct network access: the WebView only talks through typed Tauri commands (IPC), under a restrictive CSP. |
| Data | Local-first: no telemetry, no analytics and no repository content is sent. The `npm run audit:telemetry` audit fails if an analytics reference appears in the sources. |

## Out of scope

- A local repository or a remote already compromised by the user.
- The execution of Git hooks, merge tools or editors configured by the user,
  which run with their rights by design.
- Dependency vulnerabilities already fixed upstream and reported by Dependabot
  without impact on BeeBranch.
- A binary signed by the maintainers but retrieved from an unofficial source.

## Disclosure

Advisories are published via GitHub Security Advisories, with the corrective
release and, where applicable, a note in [CHANGELOG.md](CHANGELOG.md).
