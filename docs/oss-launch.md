# Going public — maintainer checklist

This checklist describes the **remaining** operations to make the repository public
and enable the merge request contribution workflow. Licensing,
governance, CI, and history elements are already in place.

## 1. Before switching

- [ ] Check that no work in progress contains secrets:
      `git status --ignored`, then `git log --all -p | grep -Ei 'BEGIN .*PRIVATE KEY|gh[pousr]_|glpat-|AKIA'`.
- [ ] Check that `src-tauri/keys/` and `.env` remain local (ignored).
- [ ] Check that the history no longer contains the work email address:
      `git log --all --format='%ae%n%ce' | sort -u`.
- [ ] Confirm the copyright holder declared in the README,
      `Cargo.toml` and `src-tauri/tauri.conf.json` (`Methamorphe`) and the
      AGPL-3.0-only license with the employer if the code was produced as
      part of employment.
- [ ] Check trademarks and assets: the logo and palette are not
      covered by the code license (see README).

## 2. Switch to public

```bash
gh repo edit Methamorphe/beebranch \
  --visibility public \
  --accept-visibility-change-consequences
```

## 3. Apply protection and security

```bash
scripts/setup-github-protection.sh Methamorphe/beebranch
```

The script is idempotent. It creates:

- a ruleset on `main`: required merge request, one approval, CODEOWNERS
  review, resolved conversations, up-to-date branch, `Frontend`,
  `Rust (ubuntu|macos|windows-latest)` and `DCO` checks, linear history, no
  force-push or deletion; administrator bypass for emergencies;
- a ruleset on `v*` tags: deletion, updates, and force-push
  prohibited;
- private vulnerability reporting, Dependabot alerts,
  automatic fixes, secret scanning, and push protection.

Then check in **Settings → Rules → Rulesets** that both rulesets are
active, and in **Security** that secret scanning and private advisories
are enabled.

## 4. Check the contribution workflow

- [ ] Open a test merge request from a fork: `Frontend`,
      `Rust`, `DCO` and `Dependency review` CI must run.
- [ ] Check that a commit without `Signed-off-by` fails `DCO`.
- [ ] Check that a direct push to `main` is rejected.
- [ ] Check that the merge button offers only squash.

## 5. First public release

The `release.yml` workflow now publishes to releases in the source repository
(`Methamorphe/beebranch`), with `GITHUB_TOKEN` and `contents: write`.

> **Clients ≤ 0.7.2**: they compile in the old endpoint
> `Methamorphe/beebranch-releases` and will not see releases from the source
> repository. No compatibility is retained: these installations must be
> reinstalled from the first public release. The 0.7.2 artifacts remain
> available in the mirror repository for this reinstallation.

- [ ] Merge `dev` into `main` after updating the three versions and
      notes; successful CI creates `v<version>` and triggers publication.
- [ ] Check that `latest.json` and `rollback.json` are attached to the release.
- [ ] Check the minisign signature and installation on a clean machine.
- [ ] Check that the `.../releases/latest/download/latest.json` URL responds.

## 6. After publication

- [ ] Pin the welcome issue and roadmap discussions if enabled.
- [ ] Monitor private advisories and Dependabot alerts.
- [ ] Never delete release N-1: `rollback.json` depends on it.
