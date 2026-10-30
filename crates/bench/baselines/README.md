# Performance baselines

`ci.json` is the baseline used by `.github/workflows/bench.yml` on the reduced
set (`--all-reduced`).

## Reference machine (initial measurement)

| Item | Value |
|---|---|
| Date | 2026-10-27 |
| OS | macOS 27 (Darwin 27.0.0), arm64 (Apple Silicon) |
| CPU / RAM | development machine, not virtualized |
| Rust | 1.98.1 |
| Git | 2.55.0 |
| Build | `cargo run -p beebranch-bench --release` (release profile, LTO) |
| Command | `beebranch-bench --root target/bench-corpus --all-reduced --runs 5 --warmup 2 --out …` |

The `p50_ms` / `p95_ms` values are the raw measurements from the report
(`summary.p50Ms`, `summary.p95Ms`), rounded to 3 decimal places. No value
is estimated.

Scenarios under 100 ms (`PERF-04`, `PERF-06`, `PERF-08`, `PERF-12`)
also carry an absolute budget of `abs_p95_ms = measured p95 × 2 + 10 ms` to
absorb scheduler outliers with 5 measurements (the nearest-rank
p95 is the maximum here). The relative factor `× 1.30` remains active when the
measurement exceeds this budget.

## Updating

1. Run the harness on the reference machine, without `--assert`.
2. Check stability (two consecutive runs below the thresholds).
3. Record the new measured `p50_ms` / `p95_ms` values.
4. Justify the change in the PR (accepted regression, new machine,
   corpus or implementation change).

Never “adjust” a baseline to pass an unexplained
regression.
