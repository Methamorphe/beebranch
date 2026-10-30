# beebranch-bench — performance harness

Deterministic harness for the **PERF-01..PERF-12** scenarios in
`docs/06-performance.md`. It drives the real read model of
`beebranch-git` (discovery, status, log, lanes, refs, status, diff) and produces a
versioned JSON report (`schema: 1`).

This crate is not bundled with the application.

## Corpus

Corpora are generated under `--root` (default `target/bench-corpus`) by a
single `git fast-import` then checked by `git reset --hard`:

| Corpus | Content | Reduced (CI PR) |
|---|---|---|
| `linear-10k` | 10,000 commits, `history.txt` | identical |
| `linear-100k` | 100,000 commits | identical |
| `linear-1m` | 1,000,000 commits (nightly) | identical |
| `branches-5k` | 100 commits, 5,000 branches, 500 tags, 5,000 remote refs | 500 / 50 / 500 |
| `merges-deep` | 1,000 chained merges (2 parents each) | 200 merges |
| `wide-200k` | 200,000 files in 1,024 directories | 20,000 files |
| `dirty-10k` | 10,000 modified / staged / untracked files | 2,000 files |
| `diff-50k` | modified 50,000-line `big.txt` | 5,000 lines |
| `crlf-unicode` | CRLF, mixed EOLs, Unicode path, file without a final `\n` | identical |
| `worktrees` | 5 linked worktrees sharing a `common dir` | identical |

Determinism: fixed seed (`--seed`, default 42), identity
`BeeBranch Bench <bench@beebranch.local>`, dates `1_600_000_000 + index` and
content derived from a splitmix64. A `.git/.beebranch-bench-corpus.json` marker
makes generation idempotent; a marked corpus is reused after
checking its commit count.

Git is never launched through `std::process`: everything goes through `GitRunner` /
`CommandSpec`. Only `ps` (RSS measurement) runs outside `beebranch-git`.

Git subcommands used by the generator: `init`, `config --local`,
`fast-import` (single stream for the entire history), `reset --hard`,
`rev-list --count`, `add`, `worktree add`. `init`, `rev-list` and `fast-import`
were added to the `beebranch-git` allowlist (the only change to this
crate, along with `merge -m/--message`); none is used by the application.

## Commands

Measuring a scenario:

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus \
  --corpus linear-10k --scenario PERF-01 \
  --runs 5 --warmup 2 \
  --out target/bench-report.json
```

Corpora are not committed: only the generator, seeds, baseline
and this README are versioned.

Reduced CI set (used by `.github/workflows/bench.yml`):

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --all-reduced \
  --runs 5 --warmup 2 \
  --out target/bench-report.json \
  --baseline crates/bench/baselines/ci.json --assert
```

Nightly (full, non-blocking):

```bash
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus \
  --corpus linear-100k --scenario PERF-01 \
  --runs 5 --warmup 2 --out target/nightly-perf01-100k.json
```

## Implemented scenarios

`PERF-01` cold opening · `PERF-02` first graph page ·
`PERF-03` appending 10 pages · `PERF-04` refs · `PERF-05` wide tree status ·
`PERF-06` modified worktree status · `PERF-07` partial staging (hunk) ·
`PERF-08` large diff ·
`PERF-09` switching between 5 worktrees (opening + first page) ·
`PERF-10` local fetch + status/refs refresh ·
`PERF-11` 5 idle repositories (RSS, CPU, `BEEBRANCH_BENCH_IDLE_MS` window,
default 5,000 ms) · `PERF-12` commit search.

`PERF-07` stages a hunk then restores the index; `PERF-10` creates a tiny
local bare remote, fetches, then rereads status and refs. No fabricated results.

The `--all-reduced` set contains the ten scenarios measurable in CI PR
(`PERF-01` .. `PERF-08`, `PERF-10`, `PERF-12`); `PERF-09` and `PERF-11` are
run manually or nightly.

## Report

`runs[]` contains `durationMs`, `rssKb`, `ipcBytes` (serialized JSON size of the
data read) and `items`. `summary` contains `p50Ms`, `p95Ms`, `minMs`,
`maxMs`, `meanMs`, `rssKbMax`, `ipcBytesMax`. Percentiles use the
nearest rank (5 measurements → p50 = 3rd value, p95 = 5th).

## Thresholds

`--assert --baseline <file>` compares each scenario to the baseline:

- allowed median = `max(optional abs_p50_ms, floor 2 ms, p50_ms × 1.20)`;
- allowed p95 = `max(optional abs_p95_ms, floor 2 ms, p95_ms × 1.30)`.

The optional `abs_p50_ms` / `abs_p95_ms` fields allow setting an
absolute budget (useful for absorbing scheduling outliers on
short operations). A scenario missing from the baseline is a regression.

Exit codes: `0` success, `1` regression, `2` harness or
usage error.

With `--assert` on a single scenario, a missing corpus is refused; generate it
first without `--assert`. `--all-reduced` generates its reduced corpora (so CI can
start cold).

## Baseline

`crates/bench/baselines/ci.json` was measured on the reference machine
described in `crates/bench/baselines/README.md`. A baseline is valid for
a given machine and build; any update must be justified in the
PR (scenario, before/after, profile or explanation of noise).
