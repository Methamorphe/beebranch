# Contributing to BeeBranch

Thanks for contributing. This repository follows strict scope and evidence
rules: a contribution is accepted when it solves the stated problem, with tests
and a demonstration of real execution.

## Environment

Prerequisites: Rust ≥ 1.85, Node ≥ 22, Git ≥ 2.34,
[Tauri 2](https://tauri.app/start/prerequisites/) system dependencies.

```bash
npm install
npm run tauri dev
```

## Branches and integration

- `dev` is the development and integration branch. Daily work and validation
  happen locally; a push to `dev` starts neither CI nor a release. The
  repository being public, its content stays visible.
- Create contribution branches from `dev` and target **`dev`** in pull
  requests. PRs to `dev` or `main` run the CI, DCO, dependency and reduced
  benchmark checks.
- `main` remains the stable default branch. Only maintainers merge `dev` into
  it, through a promotion PR, when a release is decided.
- After merging into `main`, the full CI runs. If it succeeds, the release
  workflow creates `v<version>` and publishes packages only if that tag does
  not already exist. Without a version change, no new release. See the
  [release process](docs/releases/README.md).

```bash
git fetch origin
git switch dev
git pull --ff-only
git switch -c feature/my-contribution
# After local checks and DCO-signed commits:
git push -u origin feature/my-contribution
gh pr create --base dev
```

## Scope rules

1. One contribution = one closed problem, one branch, one PR.
2. Do not widen the scope: any feature that was not requested is out of scope.
3. Do not introduce unrequested abstraction (Git backend trait, plugin system,
   generic provider).
4. A feature is **not** done because the UI exists: acceptance criteria + tests
   + evidence of real execution.
5. Any performance claim must come with a reproducible measurement
   (`cargo run -p beebranch-bench --release -- …`).
6. Any unverified assumption stays marked `[HYPOTHESIS]` in code, tests or
   documentation.
7. Unrelated work (global rename, reformatting, unrelated dependency update)
   must be a separate PR.

## Checks before a PR

```bash
npm run lint
npm run build
npm run audit:telemetry
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For a UI change, add or run the headless test:

```bash
npm run ui:smoke
```

CI on PRs and pushes to `main` re-runs the frontend and Rust checks on Linux,
macOS and Windows depending on the job. A PR that fails on
`clippy -D warnings`, `cargo fmt` or the test suite is not merged.

## Tests

- Bug: reproduce before, fix, verify after. A regression without a test must be
  justified in the PR.
- Tests must cover a visible behaviour (boundaries, invariants, errors,
  precedence), not plumbing or default values.
- UI tests do not replace a manual check of the affected flow.

## Commits and PRs

- **Every commit must be DCO 1.1 signed**: add `Signed-off-by` with
  `git commit -s`. CI (`dco.yml`, via `scripts/check-dco.sh`) rejects a commit
  whose trailer is missing or whose address differs from the author's.
- Messages in the `type(scope): description` format (`fix(release): …`,
  `chore(release): …`, `feat(graph): …`), in French or English, without emoji.
- Describe the problem, the cause, the fix and the checks that were run.
- Never commit a secret: minisign keys, Apple certificate, GitLab or GitHub
  token, `.env` file. See [SECURITY.md](SECURITY.md).
- Releases and the version are managed by the maintainers; do not modify
  `Cargo.toml`/`package.json`/`tauri.conf.json` for any other reason.

## Documentation

Any structuring decision must be recorded in `docs/adr/`. Any performance or
security claim must point to reproducible evidence. Project documentation is
written in English by default.

## Contribution license

Each commit carries a [DCO 1.1](https://developercertificate.org/) signature:
you certify that you have the right to submit the code and accept that it is
distributed under [AGPL-3.0-only](LICENSE), without additional conditions.
