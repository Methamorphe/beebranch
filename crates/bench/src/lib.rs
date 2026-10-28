//! Performance harness.
//!
//! P0-T08 adds the deterministic corpus, scenario drivers and versioned JSON
//! reports. This crate is not shipped in the desktop application; it drives the
//! real `beebranch-git` read model so measurements match application behavior.

pub mod corpus;
pub mod error;
pub mod metrics;
pub mod report;
pub mod scenario;
pub mod threshold;

use beebranch_git::GitRunner;

use crate::corpus::CorpusInfo;
use crate::error::Result;
use crate::metrics::Environment;
use crate::report::{BenchmarkReport, Metric};
use crate::scenario::ScenarioId;

/// Warm-up and measurement counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BenchConfig {
    pub warmup: u32,
    pub runs: u32,
}

impl Default for BenchConfig {
    fn default() -> Self {
        Self { warmup: 2, runs: 5 }
    }
}

/// Execute warm-ups then measured runs and build the report.
///
/// Warm-up failures abort the run: a scenario that cannot prepare is not a
/// measurement, it is a broken harness.
pub fn run_scenario(
    runner: &GitRunner,
    scenario: ScenarioId,
    corpus: &CorpusInfo,
    environment: &Environment,
    config: BenchConfig,
) -> Result<BenchmarkReport> {
    let warmup = config.warmup;
    let runs = config.runs.max(1);

    let mut last_notes = String::new();
    for _ in 0..warmup {
        let (_, run) = scenario::run_once(runner, scenario, corpus)?;
        last_notes = run.notes;
    }

    let mut metrics = Vec::with_capacity(runs as usize);
    for index in 1..=runs {
        // The scenario measures only the operation; serialization for the IPC
        // estimate happens after its timer stops.
        let (duration, run) = scenario::run_once(runner, scenario, corpus)?;
        last_notes = run.notes;
        metrics.push(Metric {
            run: index,
            duration_ms: duration.as_secs_f64() * 1000.0,
            rss_kb: run.rss_kb.unwrap_or_else(metrics::rss_kb),
            ipc_bytes: run.ipc_bytes,
            items: run.items,
        });
    }

    let notes = format!("{} — {}", scenario.title(), last_notes);
    Ok(BenchmarkReport::new(
        environment,
        corpus,
        scenario.as_str(),
        metrics,
        notes,
    ))
}
