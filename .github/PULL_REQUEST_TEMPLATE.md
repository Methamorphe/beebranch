## Problem

<!-- Observed behavior, identified cause, linked issue. -->

## Change

<!-- What changes, and why this solution rather than another. -->

## Scope

- [ ] Every commit is DCO signed (`git commit -s`).
- [ ] A single concern; no unrelated refactor.
- [ ] No new abstraction without a demonstrated need.
- [ ] No secret, token, key or `.env` file added.

## Checks

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `npm run ui:smoke` (if the UI changes)
- [ ] `npm run audit:telemetry`

Evidence of real execution (output, screenshot, replayed scenario):

<!-- Paste the evidence. A feature is not done because the UI exists. -->

## Risks and limitations

<!-- What is not covered, remaining assumptions, untested platforms. -->
