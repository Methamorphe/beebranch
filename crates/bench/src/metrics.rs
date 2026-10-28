//! Measurement helpers: percentiles, RSS sampling and environment labels.

#[cfg(unix)]
use std::process::Command;

use beebranch_git::capability::GitVersion;
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand};

use crate::error::Result;

/// Build identity recorded in every report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Environment {
    pub build: String,
    pub os: String,
    pub git_version: String,
}

impl Environment {
    /// Detect the build, OS and Git version once per invocation.
    pub fn detect(runner: &GitRunner) -> Result<Self> {
        Ok(Self {
            build: build_label(),
            os: os_label(),
            git_version: git_version(runner)?,
        })
    }
}

/// Nearest-rank percentile over an already sorted slice.
///
/// `p` is in `0..=100`. For five samples, `p50` is the third value and `p95`
/// the fifth, which is stable for the small sample counts used here.
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p.clamp(0.0, 100.0) / 100.0) * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[index]
}

/// Current resident set size of this process, in kibibytes.
///
/// Linux reads `/proc/self/statm`; other Unix targets ask `ps`. `ps` is not a
/// Git invocation, so it may use `std::process`; no Git command ever does.
pub fn rss_kb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = statm
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u64>().ok())
            {
                let page_size = 4096_u64;
                return pages.saturating_mul(page_size) / 1024;
            }
        }
    }
    rss_via_ps().unwrap_or(0)
}

#[cfg(unix)]
fn rss_via_ps() -> Option<u64> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .ok()
}

#[cfg(not(unix))]
fn rss_via_ps() -> Option<u64> {
    None
}

/// CPU time consumed by this process, in milliseconds.
///
/// Linux reads `utime`/`stime` from `/proc/self/stat` (100 ticks/s on the
/// supported platforms). Other Unix targets parse `ps -o time=`.
pub fn cpu_time_ms() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
            if let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) {
                let fields: Vec<&str> = rest.split_whitespace().collect();
                let utime = fields.get(11).and_then(|value| value.parse::<u64>().ok());
                let stime = fields.get(12).and_then(|value| value.parse::<u64>().ok());
                if let (Some(utime), Some(stime)) = (utime, stime) {
                    return (utime + stime) * 10;
                }
            }
        }
    }
    cpu_time_via_ps().unwrap_or(0)
}

#[cfg(unix)]
fn cpu_time_via_ps() -> Option<u64> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "time=", "-p", &pid])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (minutes, seconds) = text.trim().split_once(':')?;
    let minutes: u64 = minutes.parse().ok()?;
    let seconds: f64 = seconds.parse().ok()?;
    Some(minutes * 60_000 + (seconds * 1000.0) as u64)
}

#[cfg(not(unix))]
fn cpu_time_via_ps() -> Option<u64> {
    None
}

/// `name version (profile)` label for the harness binary.
pub fn build_label() -> String {
    format!(
        "{} {} ({})",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    )
}

/// `os-arch` label.
pub fn os_label() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Version of the Git binary used for the measurements.
pub fn git_version(runner: &GitRunner) -> Result<String> {
    let outcome = runner
        .run(&CommandSpec::new(
            GitSubcommand::Version,
            std::env::current_dir()?,
        ))?
        .ensure_success()?;
    let text = outcome.stdout.text_lossy();
    Ok(GitVersion::parse(&text)
        .map(|version| version.to_string())
        .unwrap_or_else(|| text.lines().next().unwrap_or("inconnu").trim().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_uses_nearest_rank() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile(&values, 0.0), 1.0);
        assert_eq!(percentile(&values, 50.0), 3.0);
        assert_eq!(percentile(&values, 95.0), 5.0);
        assert_eq!(percentile(&values, 100.0), 5.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }

    #[test]
    fn environment_labels_are_not_empty() {
        assert!(!build_label().is_empty());
        assert!(os_label().contains('-'));
    }
}
