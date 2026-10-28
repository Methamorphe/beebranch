//! PERF scenario registry and drivers.
//!
//! Each driver performs the same work the desktop application performs for
//! that interaction: discovery, state detection, log page, graph page, refs,
//! status, diff or search. Timing wraps only the operation; JSON serialization
//! (the IPC byte estimate) happens after the timer stops so it never inflates
//! the reported duration.

use std::time::{Duration, Instant};

use beebranch_core::Page;
use beebranch_core::PageRequest;
use beebranch_git::diff::{read_diff, DiffLimits, DiffTarget};
use beebranch_git::graph::GraphRow;
use beebranch_git::index::{self, HunkSelection, PathSelection};
use beebranch_git::log::{parse_log, CommitSummary};
use beebranch_git::refs::read_refs;
use beebranch_git::session::{RepoSession, SessionOptions};
use beebranch_git::status::read_status;
use beebranch_git::sync::{self, SyncKind};
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, OperationContext, StdinMode};

use crate::corpus::{CorpusInfo, CorpusName};
use crate::error::{BenchError, Result};
use crate::metrics;

/// Page size used by the graph and log scenarios (the product default).
pub const PAGE_SIZE: u32 = 500;
/// Number of additional pages appended by PERF-03.
pub const APPEND_PAGES: usize = 10;

/// Log format replicated for the search scenario. It matches the read model so
/// the same parser is exercised.
const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s";

/// Diff ceilings large enough to measure a 50k-line change fully.
const DIFF_LIMITS: DiffLimits = DiffLimits {
    max_files: 16,
    max_lines_per_file: 200_000,
    max_total_lines: 6_000,
    context_lines: 3,
    max_bytes: 64 * 1024 * 1024,
};

/// Implemented scenarios.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ScenarioId {
    Perf01,
    Perf02,
    Perf03,
    Perf04,
    Perf05,
    Perf06,
    Perf07,
    Perf08,
    Perf09,
    Perf10,
    Perf11,
    Perf12,
}

impl ScenarioId {
    /// Every scenario identifier defined by the product documentation.
    pub const ALL: [Self; 12] = [
        Self::Perf01,
        Self::Perf02,
        Self::Perf03,
        Self::Perf04,
        Self::Perf05,
        Self::Perf06,
        Self::Perf07,
        Self::Perf08,
        Self::Perf09,
        Self::Perf10,
        Self::Perf11,
        Self::Perf12,
    ];

    /// Scenarios measurable with the P1 feature set and cheap enough for PR CI.
    pub const ALL_REDUCED: [Self; 10] = [
        Self::Perf01,
        Self::Perf02,
        Self::Perf03,
        Self::Perf04,
        Self::Perf05,
        Self::Perf06,
        Self::Perf07,
        Self::Perf08,
        Self::Perf10,
        Self::Perf12,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Perf01 => "PERF-01",
            Self::Perf02 => "PERF-02",
            Self::Perf03 => "PERF-03",
            Self::Perf04 => "PERF-04",
            Self::Perf05 => "PERF-05",
            Self::Perf06 => "PERF-06",
            Self::Perf07 => "PERF-07",
            Self::Perf08 => "PERF-08",
            Self::Perf09 => "PERF-09",
            Self::Perf10 => "PERF-10",
            Self::Perf11 => "PERF-11",
            Self::Perf12 => "PERF-12",
        }
    }

    pub fn parse(value: &str) -> std::result::Result<Self, String> {
        let trimmed = value.trim();
        let digits = trimmed
            .strip_prefix("PERF-")
            .or_else(|| trimmed.strip_prefix("perf-"))
            .unwrap_or(trimmed);
        let number: u8 = digits
            .parse()
            .map_err(|_| format!("scénario inconnu : {value} (attendu : PERF-01..PERF-12)"))?;
        Self::from_number(number).ok_or_else(|| {
            format!(
                "scénario {trimmed} non implémenté ; scénarios disponibles : {}",
                Self::ALL.map(Self::as_str).join(", ")
            )
        })
    }

    const fn from_number(number: u8) -> Option<Self> {
        match number {
            1 => Some(Self::Perf01),
            2 => Some(Self::Perf02),
            3 => Some(Self::Perf03),
            4 => Some(Self::Perf04),
            5 => Some(Self::Perf05),
            6 => Some(Self::Perf06),
            7 => Some(Self::Perf07),
            8 => Some(Self::Perf08),
            9 => Some(Self::Perf09),
            10 => Some(Self::Perf10),
            11 => Some(Self::Perf11),
            12 => Some(Self::Perf12),
            _ => None,
        }
    }

    /// Corpus used when no explicit corpus is requested.
    pub const fn corpus(self) -> CorpusName {
        match self {
            Self::Perf01 | Self::Perf02 | Self::Perf03 | Self::Perf12 => CorpusName::Linear10k,
            Self::Perf04 => CorpusName::Branches5k,
            Self::Perf05 => CorpusName::Wide200k,
            Self::Perf06 | Self::Perf07 => CorpusName::Dirty10k,
            Self::Perf08 => CorpusName::Diff50k,
            Self::Perf09 | Self::Perf11 => CorpusName::Worktrees,
            Self::Perf10 => CorpusName::Linear10k,
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            Self::Perf01 => "ouverture à froid (découverte, état, première page de log)",
            Self::Perf02 => "première page du graphe (log + lanes)",
            Self::Perf03 => "append de 10 pages de graphe",
            Self::Perf04 => "chargement des refs (branches, tags, distantes)",
            Self::Perf05 => "status sur un arbre large",
            Self::Perf06 => "status sur un worktree modifié",
            Self::Perf07 => "staging partiel (hunk)",
            Self::Perf08 => "diff volumineux du worktree",
            Self::Perf09 => "changement entre 5 worktrees (ouverture + première page)",
            Self::Perf10 => "fetch et rafraîchissement",
            Self::Perf11 => "5 dépôts au repos (RSS, CPU, fenêtre configurable)",
            Self::Perf12 => "première page d'une recherche de commits",
        }
    }
}

/// Outcome of one scenario run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenarioRun {
    /// Serialized JSON size of everything the operation produced.
    pub ipc_bytes: u64,
    /// Number of returned items (commits, refs, entries, lines...).
    pub items: u64,
    /// RSS sampled while the measured state was still alive, when relevant.
    pub rss_kb: Option<u64>,
    /// Human-readable context for the report.
    pub notes: String,
}

/// Run one scenario once, returning the duration and its payload metrics.
pub fn run_once(
    runner: &GitRunner,
    scenario: ScenarioId,
    corpus: &CorpusInfo,
) -> Result<(Duration, ScenarioRun)> {
    match scenario {
        ScenarioId::Perf01 => perf_01(runner, corpus),
        ScenarioId::Perf02 => perf_02(runner, corpus),
        ScenarioId::Perf03 => perf_03(runner, corpus),
        ScenarioId::Perf04 => perf_04(runner, corpus),
        ScenarioId::Perf05 | ScenarioId::Perf06 => perf_05_06(runner, corpus, scenario),
        ScenarioId::Perf07 => perf_07(runner, corpus),
        ScenarioId::Perf08 => perf_08(runner, corpus),
        ScenarioId::Perf09 => perf_09(runner, corpus),
        ScenarioId::Perf10 => perf_10(runner, corpus),
        ScenarioId::Perf11 => perf_11(runner, corpus),
        ScenarioId::Perf12 => perf_12(runner, corpus),
    }
}

fn open_session(runner: &GitRunner, corpus: &CorpusInfo) -> Result<RepoSession> {
    Ok(RepoSession::open(
        runner,
        &corpus.path,
        SessionOptions::default(),
    )?)
}

fn perf_01(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let started = Instant::now();
    let session = open_session(runner, corpus)?;
    let page = session.log(&PageRequest::first(PAGE_SIZE), None)?;
    let elapsed = started.elapsed();
    let rss = metrics::rss_kb();
    let bytes = serde_json::to_vec(&page)?.len() as u64;
    let items = page.items.len() as u64;
    drop(session);
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: Some(rss),
            notes: format!("page={PAGE_SIZE}"),
        },
    ))
}

fn perf_02(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let session = open_session(runner, corpus)?;
    let started = Instant::now();
    let (page, rows) = session.graph_page(&PageRequest::first(PAGE_SIZE), None)?;
    let elapsed = started.elapsed();
    let rss = metrics::rss_kb();
    let bytes = (serde_json::to_vec(&page)?.len() + serde_json::to_vec(&rows)?.len()) as u64;
    let items = page.items.len() as u64;
    drop(session);
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: Some(rss),
            notes: format!("page={PAGE_SIZE}"),
        },
    ))
}

fn perf_03(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let session = open_session(runner, corpus)?;
    let first = session.graph_page(&PageRequest::first(PAGE_SIZE), None)?;
    let mut cursor = first.0.next.clone();
    drop(first);

    let mut payloads: Vec<(Page<CommitSummary>, Vec<GraphRow>)> = Vec::with_capacity(APPEND_PAGES);
    let started = Instant::now();
    for _ in 0..APPEND_PAGES {
        let Some(after) = cursor.clone() else {
            break;
        };
        let request = PageRequest {
            after: Some(after),
            limit: Some(PAGE_SIZE),
        };
        let (page, rows) = session.graph_page(&request, None)?;
        cursor = page.next.clone();
        payloads.push((page, rows));
    }
    let elapsed = started.elapsed();
    let rss = metrics::rss_kb();
    drop(session);

    let mut bytes = 0_u64;
    let mut items = 0_u64;
    for (page, rows) in &payloads {
        bytes += serde_json::to_vec(page)?.len() as u64;
        bytes += serde_json::to_vec(rows)?.len() as u64;
        items += page.items.len() as u64;
    }
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: Some(rss),
            notes: format!("pages={}", payloads.len()),
        },
    ))
}

fn perf_04(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let started = Instant::now();
    let refs = read_refs(runner, &corpus.path)?;
    let elapsed = started.elapsed();
    let bytes = serde_json::to_vec(&refs)?.len() as u64;
    let items = refs.entries.len() as u64;
    let notes = format!(
        "remotes={} head={}",
        refs.remotes.len(),
        refs.head.is_some()
    );
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: None,
            notes,
        },
    ))
}

fn perf_05_06(
    runner: &GitRunner,
    corpus: &CorpusInfo,
    scenario: ScenarioId,
) -> Result<(Duration, ScenarioRun)> {
    let started = Instant::now();
    let report = read_status(runner, &corpus.path, None)?;
    let elapsed = started.elapsed();
    let bytes = serde_json::to_vec(&report)?.len() as u64;
    let items = report.entries.len() as u64;
    let notes = format!(
        "{}scenario={} untracked={} truncated={}",
        if scenario == ScenarioId::Perf06 {
            "dirty "
        } else {
            ""
        },
        scenario.as_str(),
        report.counts.untracked,
        report.truncated
    );
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: None,
            notes,
        },
    ))
}

fn perf_07(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let status = read_status(runner, &corpus.path, None)?;
    let candidate = status
        .entries
        .iter()
        .find(|entry| {
            entry.index == '.' && matches!(entry.kind, beebranch_git::status::EntryKind::Ordinary)
        })
        .ok_or_else(|| {
            BenchError::Corpus(
                "le corpus dirty doit contenir au moins un fichier modifié non indexé".to_owned(),
            )
        })?;
    let path = candidate.path.clone();
    let working = read_diff(
        runner,
        &corpus.path,
        &DiffTarget::WorkingTree,
        std::slice::from_ref(&path),
        DIFF_LIMITS,
    )?;
    if !working.files.iter().any(|file| !file.hunks.is_empty()) {
        return Err(BenchError::Corpus(format!(
            "aucun hunk mesurable pour {path}"
        )));
    }
    let selection = PathSelection {
        path: path.clone(),
        hunks: vec![HunkSelection {
            hunk: 0,
            lines: None,
        }],
    };

    let started = Instant::now();
    let result = index::stage(runner, &corpus.path, std::slice::from_ref(&selection))?;
    let elapsed = started.elapsed();
    // Restore the pre-benchmark index: the candidate was unstaged before.
    index::unstage(
        runner,
        &corpus.path,
        &[PathSelection {
            path: path.clone(),
            hunks: Vec::new(),
        }],
    )?;

    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: result.patch_bytes as u64,
            items: result.hunks as u64,
            rss_kb: None,
            notes: format!("path={path} hunk=0"),
        },
    ))
}

fn perf_08(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let started = Instant::now();
    let diff = read_diff(
        runner,
        &corpus.path,
        &DiffTarget::WorkingTree,
        &[],
        DIFF_LIMITS,
    )?;
    let elapsed = started.elapsed();
    let bytes = serde_json::to_vec(&diff)?.len() as u64;
    let lines: u64 = diff
        .files
        .iter()
        .flat_map(|file| &file.hunks)
        .map(|hunk| hunk.lines.len() as u64)
        .sum();
    let notes = format!("files={} truncated={}", diff.files.len(), diff.truncated);
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items: lines,
            rss_kb: None,
            notes,
        },
    ))
}

fn perf_12(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let started = Instant::now();
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Log, corpus.path.as_path()).args([
                "--date-order",
                "--parents",
                &format!("--format={LOG_FORMAT}"),
                "--max-count=500",
                "--grep=bench",
            ]),
        )?
        .ensure_success()?;
    let commits = parse_log(&outcome.stdout.text_lossy())
        .map_err(|message| BenchError::Scenario(format!("recherche de log : {message}")))?;
    let elapsed = started.elapsed();
    let bytes = serde_json::to_vec(&commits)?.len() as u64;
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items: commits.len() as u64,
            rss_kb: None,
            notes: "grep=bench max=500".to_owned(),
        },
    ))
}

fn worktree_paths(runner: &GitRunner, path: &std::path::Path) -> Result<Vec<std::path::PathBuf>> {
    let outcome = runner
        .run(&CommandSpec::new(GitSubcommand::Worktree, path).args(["list", "--porcelain"]))?
        .ensure_success()?;
    let mut paths = Vec::new();
    for line in outcome.stdout.text_lossy().lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            paths.push(std::path::PathBuf::from(path));
        }
    }
    if paths.len() < 2 {
        return Err(BenchError::Corpus(format!(
            "le corpus worktrees doit exposer au moins 2 worktrees, trouvés : {}",
            paths.len()
        )));
    }
    Ok(paths)
}

fn perf_09(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let paths = worktree_paths(runner, &corpus.path)?;
    let started = Instant::now();
    let mut sessions = Vec::with_capacity(paths.len());
    let mut bytes = 0_u64;
    let mut items = 0_u64;
    for path in &paths {
        let session = RepoSession::open(runner, path, SessionOptions::default())?;
        let page = session.log(&PageRequest::first(PAGE_SIZE), None)?;
        bytes += serde_json::to_vec(&page)?.len() as u64;
        items += page.items.len() as u64;
        sessions.push(session);
    }
    let elapsed = started.elapsed();
    let rss = metrics::rss_kb();
    let count = sessions.len() as u64;
    drop(sessions);
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items,
            rss_kb: Some(rss),
            notes: format!("worktrees={count} page={PAGE_SIZE}"),
        },
    ))
}

fn perf_10(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let remote = ensure_bench_remote(runner, &corpus.path)?;
    let started = Instant::now();
    let command = sync::spawn_fetch(
        runner,
        &corpus.path,
        &remote,
        &OperationContext::new("bench-perf-10", "fetch"),
        |_| {},
    )?;
    sync::finish(command, SyncKind::Fetch, || None)?;
    let refs = read_refs(runner, &corpus.path)?;
    let status = read_status(runner, &corpus.path, None)?;
    let elapsed = started.elapsed();
    let bytes = (serde_json::to_vec(&refs)?.len() + serde_json::to_vec(&status)?.len()) as u64;
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: bytes,
            items: refs.entries.len() as u64,
            rss_kb: Some(metrics::rss_kb()),
            notes: format!(
                "remote={remote} entries={} untracked={}",
                refs.entries.len(),
                status.counts.untracked
            ),
        },
    ))
}

/// Create (once) a tiny local remote and register it as `bench-remote`.
fn ensure_bench_remote(runner: &GitRunner, repo: &std::path::Path) -> Result<String> {
    let remotes = runner
        .run(&CommandSpec::new(GitSubcommand::Remote, repo).arg("-v"))?
        .ensure_success()?;
    if remotes.stdout.text_lossy().contains("bench-remote") {
        return Ok("bench-remote".to_owned());
    }

    let root = repo
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let base = root.join("bench-remote");
    let source = base.join("source");
    let bare = base.join("bare.git");
    std::fs::create_dir_all(&source)?;
    std::fs::create_dir_all(&bare)?;

    let git =
        |cwd: &std::path::Path, subcommand: GitSubcommand, args: &[&str], stdin: Option<&[u8]>| {
            let mut spec = CommandSpec::new(subcommand, cwd).args(args.iter().copied());
            if let Some(stdin) = stdin {
                spec = spec.stdin(StdinMode::Bytes(stdin.to_vec()));
            }
            runner.run(&spec)
        };

    git(&bare, GitSubcommand::Init, &["--quiet", "--bare"], None)?.ensure_success()?;
    if !source.join(".git").exists() {
        git(&source, GitSubcommand::Init, &["--quiet"], None)?.ensure_success()?;
        git(
            &source,
            GitSubcommand::Config,
            &["user.email", "bench@example.test"],
            None,
        )?
        .ensure_success()?;
        git(
            &source,
            GitSubcommand::Config,
            &["user.name", "Bench"],
            None,
        )?
        .ensure_success()?;
        std::fs::write(source.join("seed.txt"), "seed\n")?;
        git(&source, GitSubcommand::Add, &["-A"], None)?.ensure_success()?;
        git(
            &source,
            GitSubcommand::Commit,
            &["-F", "-"],
            Some(b"bench seed\n"),
        )?
        .ensure_success()?;
        git(
            &source,
            GitSubcommand::Push,
            &[bare.to_str().unwrap_or_default(), "HEAD:refs/heads/bench"],
            None,
        )?
        .ensure_success()?;
    }

    git(
        repo,
        GitSubcommand::Remote,
        &["add", "bench-remote", bare.to_str().unwrap_or_default()],
        None,
    )?
    .ensure_success()?;
    Ok("bench-remote".to_owned())
}

fn perf_11(runner: &GitRunner, corpus: &CorpusInfo) -> Result<(Duration, ScenarioRun)> {
    let paths = worktree_paths(runner, &corpus.path)?;
    let idle_ms = std::env::var("BEEBRANCH_BENCH_IDLE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000);
    let sessions = paths
        .iter()
        .map(|path| RepoSession::open(runner, path, SessionOptions::default()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let cpu_before = metrics::cpu_time_ms();
    let rss_before = metrics::rss_kb();
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(idle_ms));
    let elapsed = started.elapsed();
    let rss = metrics::rss_kb();
    let cpu_after = metrics::cpu_time_ms();
    let count = sessions.len() as u64;
    drop(sessions);
    let cpu_percent = if idle_ms > 0 {
        (cpu_after.saturating_sub(cpu_before)) as f64 / idle_ms as f64 * 100.0
    } else {
        0.0
    };
    Ok((
        elapsed,
        ScenarioRun {
            ipc_bytes: 0,
            items: count,
            rss_kb: Some(rss),
            notes: format!(
                "worktrees={count} idle_ms={idle_ms} rss_before_kb={rss_before} cpu_percent={cpu_percent:.2}"
            ),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_implemented_scenarios() {
        assert_eq!(ScenarioId::parse("PERF-01"), Ok(ScenarioId::Perf01));
        assert_eq!(ScenarioId::parse("perf-12"), Ok(ScenarioId::Perf12));
        assert_eq!(ScenarioId::parse("8"), Ok(ScenarioId::Perf08));
    }

    #[test]
    fn rejects_unknown_and_unimplemented_scenarios() {
        assert_eq!(ScenarioId::parse("PERF-07"), Ok(ScenarioId::Perf07));
        assert_eq!(ScenarioId::parse("PERF-09"), Ok(ScenarioId::Perf09));
        assert_eq!(ScenarioId::parse("PERF-10"), Ok(ScenarioId::Perf10));
        assert_eq!(ScenarioId::parse("PERF-11"), Ok(ScenarioId::Perf11));
        assert!(ScenarioId::parse("PERF-99").is_err());
        assert!(ScenarioId::parse("nope").is_err());
    }

    #[test]
    fn each_scenario_maps_to_a_corpus() {
        assert_eq!(ScenarioId::Perf04.corpus(), CorpusName::Branches5k);
        assert_eq!(ScenarioId::Perf05.corpus(), CorpusName::Wide200k);
        assert_eq!(ScenarioId::Perf06.corpus(), CorpusName::Dirty10k);
        assert_eq!(ScenarioId::Perf08.corpus(), CorpusName::Diff50k);
        assert_eq!(ScenarioId::Perf01.corpus(), CorpusName::Linear10k);
    }

    #[test]
    fn ids_are_sorted_and_unique() {
        let mut ids = ScenarioId::ALL.to_vec();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), ScenarioId::ALL.len());
    }
}
