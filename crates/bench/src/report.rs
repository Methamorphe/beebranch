//! Versioned JSON report.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::corpus::{CorpusInfo, CorpusName, CorpusScale};
use crate::error::{BenchError, Result};
use crate::metrics::{percentile, Environment};

/// Report schema. Bump on any incompatible change.
pub const REPORT_SCHEMA: u32 = 1;

/// Corpus identity recorded in the report (no absolute path: reports stay
/// comparable between machines).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusRef {
    pub name: String,
    pub seed: u64,
    pub scale: String,
    pub commits: u64,
    pub files: u64,
}

impl CorpusRef {
    pub fn from_info(info: &CorpusInfo) -> Self {
        Self {
            name: info.name.as_str().to_owned(),
            seed: info.seed,
            scale: info.scale.as_str().to_owned(),
            commits: info.commits,
            files: info.files,
        }
    }

    pub fn from_parts(
        name: CorpusName,
        seed: u64,
        scale: CorpusScale,
        commits: u64,
        files: u64,
    ) -> Self {
        Self {
            name: name.as_str().to_owned(),
            seed,
            scale: scale.as_str().to_owned(),
            commits,
            files,
        }
    }
}

/// One measured run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// 1-based run index, warm-up excluded.
    pub run: u32,
    pub duration_ms: f64,
    pub rss_kb: u64,
    /// Estimated IPC payload: serialized JSON size of the data read.
    pub ipc_bytes: u64,
    /// Number of items returned by the operation (commits, refs, files...).
    pub items: u64,
}

/// Aggregated measurements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
    pub rss_kb_max: u64,
    pub ipc_bytes_max: u64,
}

impl Summary {
    pub fn from_metrics(metrics: &[Metric]) -> Self {
        let mut durations: Vec<f64> = metrics.iter().map(|metric| metric.duration_ms).collect();
        durations.sort_by(f64::total_cmp);
        let mean = if durations.is_empty() {
            0.0
        } else {
            durations.iter().sum::<f64>() / durations.len() as f64
        };
        Self {
            p50_ms: percentile(&durations, 50.0),
            p95_ms: percentile(&durations, 95.0),
            min_ms: durations.first().copied().unwrap_or(0.0),
            max_ms: durations.last().copied().unwrap_or(0.0),
            mean_ms: mean,
            rss_kb_max: metrics
                .iter()
                .map(|metric| metric.rss_kb)
                .max()
                .unwrap_or(0),
            ipc_bytes_max: metrics
                .iter()
                .map(|metric| metric.ipc_bytes)
                .max()
                .unwrap_or(0),
        }
    }
}

/// Single-scenario report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub schema: u32,
    pub build: String,
    pub os: String,
    pub git_version: String,
    pub corpus: CorpusRef,
    pub scenario: String,
    pub runs: Vec<Metric>,
    pub summary: Summary,
    pub notes: String,
}

impl BenchmarkReport {
    pub fn new(
        environment: &Environment,
        corpus: &CorpusInfo,
        scenario: impl Into<String>,
        runs: Vec<Metric>,
        notes: impl Into<String>,
    ) -> Self {
        let summary = Summary::from_metrics(&runs);
        Self {
            schema: REPORT_SCHEMA,
            build: environment.build.clone(),
            os: environment.os.clone(),
            git_version: environment.git_version.clone(),
            corpus: CorpusRef::from_info(corpus),
            scenario: scenario.into(),
            runs,
            summary,
            notes: notes.into(),
        }
    }
}

/// Report produced by `--all-reduced`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub schema: u32,
    pub build: String,
    pub os: String,
    pub git_version: String,
    pub reports: Vec<BenchmarkReport>,
}

impl BatchReport {
    pub fn new(environment: &Environment, mut reports: Vec<BenchmarkReport>) -> Self {
        reports.sort_by(|left, right| left.scenario.cmp(&right.scenario));
        Self {
            schema: REPORT_SCHEMA,
            build: environment.build.clone(),
            os: environment.os.clone(),
            git_version: environment.git_version.clone(),
            reports,
        }
    }
}

/// Write a report to `path`, or to stdout when the path is `None` or `-`.
pub fn write_json<T: Serialize>(path: Option<&Path>, value: &T) -> Result<()> {
    match path {
        None => print_json(&mut io::stdout().lock(), value),
        Some(path) if path.as_os_str() == "-" => print_json(&mut io::stdout().lock(), value),
        Some(path) => {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::File::create(path)?;
            print_json(&mut file, value)
        }
    }
}

fn print_json<T: Serialize>(writer: &mut dyn Write, value: &T) -> Result<()> {
    serde_json::to_writer_pretty(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

/// Read a report back (used by tests and by CI tooling).
pub fn read_report(path: &Path) -> Result<BenchmarkReport> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(BenchError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metric(run: u32, duration_ms: f64) -> Metric {
        Metric {
            run,
            duration_ms,
            rss_kb: 1024 * run as u64,
            ipc_bytes: 512 * run as u64,
            items: 10,
        }
    }

    fn report() -> BenchmarkReport {
        let environment = Environment {
            build: "beebranch-bench 0.1.0 (release)".to_owned(),
            os: "macos-aarch64".to_owned(),
            git_version: "2.55.0".to_owned(),
        };
        let corpus = CorpusRef::from_parts(CorpusName::Linear10k, 42, CorpusScale::Full, 10, 1);
        let metrics = vec![
            metric(1, 10.0),
            metric(2, 12.0),
            metric(3, 20.0),
            metric(4, 11.0),
            metric(5, 30.0),
        ];
        BenchmarkReport {
            schema: REPORT_SCHEMA,
            build: environment.build,
            os: environment.os,
            git_version: environment.git_version,
            corpus,
            scenario: "PERF-01".to_owned(),
            runs: metrics.clone(),
            summary: Summary::from_metrics(&metrics),
            notes: "test".to_owned(),
        }
    }

    #[test]
    fn summary_uses_p50_and_p95() {
        let report = report();
        assert_eq!(report.summary.p50_ms, 12.0);
        assert_eq!(report.summary.p95_ms, 30.0);
        assert_eq!(report.summary.min_ms, 10.0);
        assert_eq!(report.summary.max_ms, 30.0);
        assert_eq!(report.summary.rss_kb_max, 5120);
    }

    #[test]
    fn report_serializes_with_camel_case_and_schema() {
        let value = serde_json::to_value(report()).expect("serialize");
        assert_eq!(value["schema"], REPORT_SCHEMA);
        assert_eq!(value["gitVersion"], "2.55.0");
        assert_eq!(value["summary"]["p50Ms"], 12.0);
        assert_eq!(value["runs"][0]["durationMs"], 10.0);
        assert_eq!(value["corpus"]["name"], "linear-10k");
        assert!(value.get("git_version").is_none());
    }

    #[test]
    fn report_round_trips() {
        let original = report();
        let text = serde_json::to_string(&original).expect("serialize");
        let decoded: BenchmarkReport = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(decoded, original);
    }
}
