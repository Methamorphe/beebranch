//! Baseline comparison.
//!
//! A regression is reported when the measured median exceeds
//! `max(absolute_floor, baseline_p50 * 1.20)` or the measured p95 exceeds
//! `max(absolute_floor, baseline_p95 * 1.30)`. The absolute floor absorbs
//! timer noise on sub-millisecond operations.
//!
//! The baseline file is a flat object keyed by scenario:
//!
//! ```json
//! { "PERF-01": { "p50_ms": 42.0, "p95_ms": 55.0 } }
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::report::BenchmarkReport;

/// Median tolerance over the baseline.
pub const MEDIAN_FACTOR: f64 = 1.20;
/// p95 tolerance over the baseline.
pub const P95_FACTOR: f64 = 1.30;
/// Absolute floor, in milliseconds, below which a difference is noise.
pub const ABSOLUTE_FLOOR_MS: f64 = 2.0;

/// One scenario's baseline values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaselineEntry {
    #[serde(rename = "p50_ms")]
    pub p50_ms: f64,
    #[serde(rename = "p95_ms")]
    pub p95_ms: f64,
    /// Optional absolute median budget; raises the allowed value.
    #[serde(
        default,
        rename = "abs_p50_ms",
        skip_serializing_if = "Option::is_none"
    )]
    pub abs_p50_ms: Option<f64>,
    /// Optional absolute p95 budget; raises the allowed value.
    #[serde(
        default,
        rename = "abs_p95_ms",
        skip_serializing_if = "Option::is_none"
    )]
    pub abs_p95_ms: Option<f64>,
}

/// Scenario-keyed baseline.
pub type Baseline = BTreeMap<String, BaselineEntry>;

/// A single threshold violation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Regression {
    pub scenario: String,
    /// `p50`, `p95` or `baseline`.
    pub metric: String,
    pub measured_ms: f64,
    pub allowed_ms: f64,
    pub baseline_ms: f64,
    pub detail: String,
}

impl fmt::Display for Regression {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} {} : mesuré {:.3} ms > autorisé {:.3} ms (baseline {:.3} ms) — {}",
            self.scenario,
            self.metric,
            self.measured_ms,
            self.allowed_ms,
            self.baseline_ms,
            self.detail
        )
    }
}

/// Load a baseline file.
pub fn load_baseline(path: &Path) -> Result<Baseline> {
    let text = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

/// Allowed median for an entry.
pub fn allowed_p50(entry: &BaselineEntry) -> f64 {
    let relative = entry.p50_ms * MEDIAN_FACTOR;
    let absolute = entry.abs_p50_ms.unwrap_or(0.0).max(ABSOLUTE_FLOOR_MS);
    relative.max(absolute)
}

/// Allowed p95 for an entry.
pub fn allowed_p95(entry: &BaselineEntry) -> f64 {
    let relative = entry.p95_ms * P95_FACTOR;
    let absolute = entry.abs_p95_ms.unwrap_or(0.0).max(ABSOLUTE_FLOOR_MS);
    relative.max(absolute)
}

/// Compare one report against the baseline.
///
/// Returns `Err` with every violation; an unknown scenario is itself a
/// violation because an unguarded scenario cannot be trusted in CI.
pub fn check_baseline(
    report: &BenchmarkReport,
    baseline: &Baseline,
) -> std::result::Result<(), Vec<Regression>> {
    let Some(entry) = baseline.get(&report.scenario) else {
        return Err(vec![Regression {
            scenario: report.scenario.clone(),
            metric: "baseline".to_owned(),
            measured_ms: report.summary.p50_ms,
            allowed_ms: 0.0,
            baseline_ms: 0.0,
            detail: "aucune entrée de baseline pour ce scénario".to_owned(),
        }]);
    };

    let mut regressions = Vec::new();
    let allowed_median = allowed_p50(entry);
    if report.summary.p50_ms > allowed_median {
        regressions.push(Regression {
            scenario: report.scenario.clone(),
            metric: "p50".to_owned(),
            measured_ms: report.summary.p50_ms,
            allowed_ms: allowed_median,
            baseline_ms: entry.p50_ms,
            detail: format!("médiane au-delà de ×{MEDIAN_FACTOR:.2} la baseline"),
        });
    }

    let allowed_p95 = allowed_p95(entry);
    if report.summary.p95_ms > allowed_p95 {
        regressions.push(Regression {
            scenario: report.scenario.clone(),
            metric: "p95".to_owned(),
            measured_ms: report.summary.p95_ms,
            allowed_ms: allowed_p95,
            baseline_ms: entry.p95_ms,
            detail: format!("p95 au-delà de ×{P95_FACTOR:.2} la baseline"),
        });
    }

    if regressions.is_empty() {
        Ok(())
    } else {
        Err(regressions)
    }
}

/// Check every report of a batch, concatenating violations.
pub fn check_all(reports: &[BenchmarkReport], baseline: &Baseline) -> Vec<Regression> {
    let mut regressions = Vec::new();
    for report in reports {
        if let Err(mut violations) = check_baseline(report, baseline) {
            regressions.append(&mut violations);
        }
    }
    regressions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::{CorpusName, CorpusScale};
    use crate::report::{BenchmarkReport, CorpusRef, Metric, Summary};

    fn report(scenario: &str, p50: f64, p95: f64) -> BenchmarkReport {
        let metrics = vec![Metric {
            run: 1,
            duration_ms: p50,
            rss_kb: 1,
            ipc_bytes: 1,
            items: 1,
        }];
        BenchmarkReport {
            schema: 1,
            build: "bench".to_owned(),
            os: "test".to_owned(),
            git_version: "2.55.0".to_owned(),
            corpus: CorpusRef::from_parts(CorpusName::Linear10k, 1, CorpusScale::Full, 1, 1),
            scenario: scenario.to_owned(),
            runs: metrics,
            summary: Summary {
                p50_ms: p50,
                p95_ms: p95,
                min_ms: p50,
                max_ms: p95,
                mean_ms: p50,
                rss_kb_max: 1,
                ipc_bytes_max: 1,
            },
            notes: String::new(),
        }
    }

    fn baseline(entry: BaselineEntry) -> Baseline {
        let mut map = Baseline::new();
        map.insert("PERF-01".to_owned(), entry);
        map
    }

    fn entry(p50: f64, p95: f64) -> BaselineEntry {
        BaselineEntry {
            p50_ms: p50,
            p95_ms: p95,
            abs_p50_ms: None,
            abs_p95_ms: None,
        }
    }

    #[test]
    fn accepts_within_tolerance() {
        let baseline = baseline(entry(100.0, 120.0));
        let report = report("PERF-01", 119.0, 155.0);
        assert!(check_baseline(&report, &baseline).is_ok());
    }

    #[test]
    fn rejects_slow_median() {
        let baseline = baseline(entry(100.0, 120.0));
        let report = report("PERF-01", 121.0, 120.0);
        let error = check_baseline(&report, &baseline).expect_err("must fail");
        assert_eq!(error.len(), 1);
        assert_eq!(error[0].metric, "p50");
        assert!((error[0].allowed_ms - 120.0).abs() < f64::EPSILON);
    }

    #[test]
    fn rejects_slow_p95() {
        let baseline = baseline(entry(100.0, 120.0));
        let report = report("PERF-01", 100.0, 157.0);
        let error = check_baseline(&report, &baseline).expect_err("must fail");
        assert_eq!(error[0].metric, "p95");
        assert!((error[0].allowed_ms - 156.0).abs() < f64::EPSILON);
    }

    #[test]
    fn absolute_floor_absorbs_noise() {
        let baseline = baseline(entry(0.5, 0.5));
        assert!((allowed_p50(&entry(0.5, 0.5)) - ABSOLUTE_FLOOR_MS).abs() < f64::EPSILON);
        let within_noise = report("PERF-01", 1.5, 1.5);
        assert!(check_baseline(&within_noise, &baseline).is_ok());
        let above_noise = report("PERF-01", 2.5, 2.5);
        assert!(check_baseline(&above_noise, &baseline).is_err());
    }

    #[test]
    fn absolute_budget_raises_allowed_value() {
        let configured = BaselineEntry {
            p50_ms: 10.0,
            p95_ms: 10.0,
            abs_p50_ms: Some(50.0),
            abs_p95_ms: Some(60.0),
        };
        assert!((allowed_p50(&configured) - 50.0).abs() < f64::EPSILON);
        assert!((allowed_p95(&configured) - 60.0).abs() < f64::EPSILON);
    }

    #[test]
    fn missing_baseline_is_a_regression() {
        let report = report("PERF-99", 1.0, 1.0);
        let error = check_baseline(&report, &Baseline::new()).expect_err("must fail");
        assert_eq!(error[0].metric, "baseline");
        assert_eq!(error[0].scenario, "PERF-99");
    }

    #[test]
    fn baseline_deserializes_snake_case_keys() {
        let text = r#"{"PERF-01":{"p50_ms":1.5,"p95_ms":2.5}}"#;
        let baseline: Baseline = serde_json::from_str(text).expect("parse");
        assert_eq!(baseline["PERF-01"].p50_ms, 1.5);
        assert_eq!(baseline["PERF-01"].p95_ms, 2.5);
        assert!(baseline["PERF-01"].abs_p50_ms.is_none());
    }
}
