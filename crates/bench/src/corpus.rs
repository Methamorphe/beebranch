//! Deterministic synthetic corpora.
//!
//! Every corpus is a real Git repository produced through [`GitRunner`]: Git
//! is never spawned with `std::process`. History is written with a single
//! `git fast-import` stream (one process for the whole corpus), then checked
//! out with `git reset --hard`. A marker file makes generation idempotent.
//!
//! Determinism levers: fixed seed, fixed author/committer identity, timestamps
//! derived from a fixed epoch plus the commit index, and content derived from a
//! splitmix64 hash of `(seed, index)`. No clock, hostname or locale is read.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use beebranch_git::{CommandOutcome, CommandSpec, GitRunner, GitSubcommand};
use serde::{Deserialize, Serialize};

use crate::error::{BenchError, Result};

/// Marker filename, written inside the corpus `.git` directory so the
/// worktree stays byte-exact (no untracked marker in `git status`).
pub const MARKER_FILE: &str = ".beebranch-bench-corpus.json";
/// Marker schema.
pub const MARKER_SCHEMA: u32 = 1;
/// Generator revision; bump when the generated layout changes.
pub const GENERATOR_VERSION: u32 = 1;
/// Base author/committer timestamp (2020-09-13T12:26:40Z).
pub const BASE_EPOCH: i64 = 1_600_000_000;
/// Fixed identity used for every command and every synthetic commit.
pub const IDENTITY: &str = "BeeBranch Bench <bench@beebranch.local>";

const LONG_TIMEOUT: Duration = Duration::from_secs(900);
const MEDIUM_TIMEOUT: Duration = Duration::from_secs(120);

/// Supported corpus names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CorpusName {
    #[serde(rename = "linear-10k")]
    Linear10k,
    #[serde(rename = "linear-100k")]
    Linear100k,
    #[serde(rename = "linear-1m")]
    Linear1m,
    #[serde(rename = "branches-5k")]
    Branches5k,
    #[serde(rename = "merges-deep")]
    MergesDeep,
    #[serde(rename = "wide-200k")]
    Wide200k,
    #[serde(rename = "dirty-10k")]
    Dirty10k,
    #[serde(rename = "diff-50k")]
    Diff50k,
    #[serde(rename = "crlf-unicode")]
    CrlfUnicode,
    #[serde(rename = "worktrees")]
    Worktrees,
}

impl CorpusName {
    pub const ALL: [Self; 10] = [
        Self::Linear10k,
        Self::Linear100k,
        Self::Linear1m,
        Self::Branches5k,
        Self::MergesDeep,
        Self::Wide200k,
        Self::Dirty10k,
        Self::Diff50k,
        Self::CrlfUnicode,
        Self::Worktrees,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Linear10k => "linear-10k",
            Self::Linear100k => "linear-100k",
            Self::Linear1m => "linear-1m",
            Self::Branches5k => "branches-5k",
            Self::MergesDeep => "merges-deep",
            Self::Wide200k => "wide-200k",
            Self::Dirty10k => "dirty-10k",
            Self::Diff50k => "diff-50k",
            Self::CrlfUnicode => "crlf-unicode",
            Self::Worktrees => "worktrees",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|name| name.as_str().eq_ignore_ascii_case(value.trim()))
    }
}

/// Full-size corpus or the reduced variant used on pull requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CorpusScale {
    #[default]
    #[serde(rename = "full")]
    Full,
    #[serde(rename = "reduced")]
    Reduced,
}

impl CorpusScale {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Reduced => "reduced",
        }
    }
}

/// Corpus to generate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorpusSpec {
    pub name: CorpusName,
    pub seed: u64,
    pub scale: CorpusScale,
}

impl CorpusSpec {
    pub const fn full(name: CorpusName, seed: u64) -> Self {
        Self {
            name,
            seed,
            scale: CorpusScale::Full,
        }
    }

    pub const fn reduced(name: CorpusName, seed: u64) -> Self {
        Self {
            name,
            seed,
            scale: CorpusScale::Reduced,
        }
    }

    /// Some corpora do not depend on the scale (linear history, CRLF fixture,
    /// worktrees). Normalizing them keeps one marker instead of regenerating
    /// an identical corpus when alternating full and reduced runs.
    pub fn effective(self) -> Self {
        let scale_sensitive = matches!(
            self.name,
            CorpusName::Branches5k
                | CorpusName::MergesDeep
                | CorpusName::Wide200k
                | CorpusName::Dirty10k
                | CorpusName::Diff50k
        );
        if self.scale == CorpusScale::Reduced && !scale_sensitive {
            Self {
                scale: CorpusScale::Full,
                ..self
            }
        } else {
            self
        }
    }
}

/// Result of [`Corpus::ensure`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusInfo {
    pub name: CorpusName,
    pub seed: u64,
    pub scale: CorpusScale,
    pub path: PathBuf,
    pub commits: u64,
    pub files: u64,
    /// True when an existing corpus was validated and reused.
    pub reused: bool,
}

/// Declared sizes, used by tests and by the report before generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorpusSizes {
    pub commits: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Copy)]
struct Plan {
    commits: u64,
    files: u64,
    branches: u64,
    tags: u64,
    remotes: u64,
    depth: u64,
    lines: u64,
    worktrees: u64,
}

impl Plan {
    const fn new(commits: u64, files: u64) -> Self {
        Self {
            commits,
            files,
            branches: 0,
            tags: 0,
            remotes: 0,
            depth: 0,
            lines: 0,
            worktrees: 0,
        }
    }
}

fn plan(spec: &CorpusSpec) -> Plan {
    let reduced = spec.scale == CorpusScale::Reduced;
    match spec.name {
        CorpusName::Linear10k => Plan::new(10_000, 1),
        CorpusName::Linear100k => Plan::new(100_000, 1),
        CorpusName::Linear1m => Plan::new(1_000_000, 1),
        CorpusName::Branches5k => Plan {
            branches: if reduced { 500 } else { 5_000 },
            tags: if reduced { 50 } else { 500 },
            remotes: if reduced { 500 } else { 5_000 },
            ..Plan::new(100, 20)
        },
        CorpusName::MergesDeep => {
            let depth = if reduced { 200 } else { 1_000 };
            Plan {
                depth,
                ..Plan::new(depth * 2 + 1, 1)
            }
        }
        CorpusName::Wide200k => Plan::new(1, if reduced { 20_000 } else { 200_000 }),
        CorpusName::Dirty10k => Plan::new(1, if reduced { 2_000 } else { 10_000 }),
        CorpusName::Diff50k => Plan {
            lines: if reduced { 5_000 } else { 50_000 },
            ..Plan::new(1, 1)
        },
        CorpusName::CrlfUnicode => Plan::new(1, 4),
        CorpusName::Worktrees => Plan {
            worktrees: 5,
            ..Plan::new(20, 10)
        },
    }
}

/// Declared sizes for a spec.
pub fn sizes(spec: &CorpusSpec) -> CorpusSizes {
    let plan = plan(&spec.effective());
    CorpusSizes {
        commits: plan.commits,
        files: plan.files,
    }
}

/// Corpus namespace.
pub struct Corpus;

impl Corpus {
    /// Ensure the corpus exists under `root`, generating it when absent.
    ///
    /// Idempotent: a directory carrying a matching marker (same name, seed,
    /// scale and generator version) is validated with `git rev-list --count`
    /// and reused.
    pub fn ensure(root: impl AsRef<Path>, spec: &CorpusSpec) -> Result<CorpusInfo> {
        let spec = &spec.effective();
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let path = root.join(spec.name.as_str());
        let runner = GitRunner::detect()?;

        if let Some(marker) = marker_matches(&path, spec) {
            let worktrees_ok = linked_worktrees_ready(&root, spec);
            if worktrees_ok {
                if let Ok(commits) = count_commits(&runner, &path) {
                    if commits == marker.commits {
                        return Ok(CorpusInfo {
                            name: spec.name,
                            seed: spec.seed,
                            scale: spec.scale,
                            path,
                            commits,
                            files: marker.files,
                            reused: true,
                        });
                    }
                }
            }
        }

        let worktrees = worktree_root(&root, spec.name);
        if worktrees.exists() {
            fs::remove_dir_all(&worktrees)?;
        }
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }

        generate(&runner, &root, &path, spec)?;

        let commits = count_commits(&runner, &path)?;
        let files = plan(spec).files;
        let marker = CorpusMarker {
            schema: MARKER_SCHEMA,
            generator_version: GENERATOR_VERSION,
            name: spec.name.as_str().to_owned(),
            seed: spec.seed,
            scale: spec.scale.as_str().to_owned(),
            commits,
            files,
        };
        let text = serde_json::to_string_pretty(&marker)?;
        fs::write(marker_path(&path), format!("{text}\n"))?;

        Ok(CorpusInfo {
            name: spec.name,
            seed: spec.seed,
            scale: spec.scale,
            path,
            commits,
            files,
            reused: false,
        })
    }

    /// True when a matching, marker-carrying corpus is already present.
    ///
    /// This is a cheap check (no Git process) used by `--assert` to refuse a
    /// run on a corpus it would have to generate.
    pub fn is_ready(root: impl AsRef<Path>, spec: &CorpusSpec) -> bool {
        let spec = spec.effective();
        let path = root.as_ref().join(spec.name.as_str());
        marker_matches(&path, &spec).is_some()
    }

    /// Absolute path of the corpus directory (no filesystem access).
    pub fn path(root: impl AsRef<Path>, spec: &CorpusSpec) -> PathBuf {
        root.as_ref().join(spec.name.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusMarker {
    schema: u32,
    generator_version: u32,
    name: String,
    seed: u64,
    scale: String,
    commits: u64,
    files: u64,
}

fn marker_path(path: &Path) -> PathBuf {
    path.join(".git").join(MARKER_FILE)
}

fn marker_matches(path: &Path, spec: &CorpusSpec) -> Option<CorpusMarker> {
    let text = fs::read_to_string(marker_path(path)).ok()?;
    let marker: CorpusMarker = serde_json::from_str(&text).ok()?;
    let matches = marker.schema == MARKER_SCHEMA
        && marker.generator_version == GENERATOR_VERSION
        && marker.name == spec.name.as_str()
        && marker.seed == spec.seed
        && marker.scale == spec.scale.as_str();
    matches.then_some(marker)
}

fn worktree_root(root: &Path, name: CorpusName) -> PathBuf {
    root.join(format!("{}-linked", name.as_str()))
}

fn linked_worktrees_ready(root: &Path, spec: &CorpusSpec) -> bool {
    if spec.name != CorpusName::Worktrees {
        return true;
    }
    let root = worktree_root(root, spec.name);
    (0..plan(spec).worktrees).all(|index| root.join(format!("wt-{index}")).is_dir())
}

fn generate(runner: &GitRunner, root: &Path, dir: &Path, spec: &CorpusSpec) -> Result<()> {
    fs::create_dir_all(dir)?;
    let plan = plan(spec);

    run(
        runner,
        with_identity(
            CommandSpec::new(GitSubcommand::Init, dir).args(["--quiet", "--initial-branch=main"]),
            0,
        ),
    )?;

    // Keep checkouts byte-exact (CRLF corpus) even with a global autocrlf.
    run(
        runner,
        with_identity(
            CommandSpec::new(GitSubcommand::Config, dir).args([
                "--local",
                "core.autocrlf",
                "false",
            ]),
            0,
        ),
    )?;

    let stream_path = dir.join(".git").join("beebranch-bench.import");
    write_stream(&stream_path, spec, &plan)?;
    let imported = run(
        runner,
        with_identity(
            CommandSpec::new(GitSubcommand::FastImport, dir)
                .arg("--quiet")
                .stdin(beebranch_git::StdinMode::File(stream_path.clone()))
                .timeout(LONG_TIMEOUT),
            plan.commits,
        ),
    );
    let _ = fs::remove_file(&stream_path);
    imported?;

    run(
        runner,
        with_identity(
            CommandSpec::new(GitSubcommand::Reset, dir)
                .arg("--hard")
                .timeout(LONG_TIMEOUT),
            plan.commits,
        ),
    )?;

    match spec.name {
        CorpusName::Dirty10k => make_dirty(runner, dir, &plan)?,
        CorpusName::Diff50k => apply_diff_worktree(dir, &plan, spec.seed)?,
        CorpusName::Worktrees => create_worktrees(runner, root, dir, &plan)?,
        _ => {}
    }

    Ok(())
}

fn run(runner: &GitRunner, spec: CommandSpec) -> Result<CommandOutcome> {
    Ok(runner.run(&spec)?.ensure_success()?)
}

fn with_identity(spec: CommandSpec, index: u64) -> CommandSpec {
    let timestamp = format!("{} +0000", BASE_EPOCH + index as i64);
    spec.env("GIT_AUTHOR_NAME", "BeeBranch Bench")
        .env("GIT_AUTHOR_EMAIL", "bench@beebranch.local")
        .env("GIT_COMMITTER_NAME", "BeeBranch Bench")
        .env("GIT_COMMITTER_EMAIL", "bench@beebranch.local")
        .env("GIT_AUTHOR_DATE", timestamp.clone())
        .env("GIT_COMMITTER_DATE", timestamp)
}

fn count_commits(runner: &GitRunner, path: &Path) -> Result<u64> {
    let outcome = run(
        runner,
        CommandSpec::new(GitSubcommand::RevList, path)
            .args(["--count", "HEAD"])
            .timeout(MEDIUM_TIMEOUT),
    )?;
    outcome
        .stdout
        .text_lossy()
        .trim()
        .parse()
        .map_err(|_| BenchError::Corpus("décompte de commits illisible".to_owned()))
}

// ---------------------------------------------------------------------------
// fast-import stream
// ---------------------------------------------------------------------------

fn write_stream(path: &Path, spec: &CorpusSpec, plan: &Plan) -> std::io::Result<()> {
    let file = File::create(path)?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    match spec.name {
        CorpusName::Linear10k | CorpusName::Linear100k | CorpusName::Linear1m => {
            write_linear(&mut out, spec.seed, plan.commits)?
        }
        CorpusName::Branches5k => write_branches(&mut out, spec.seed, plan)?,
        CorpusName::MergesDeep => write_merges(&mut out, plan)?,
        CorpusName::Wide200k => write_wide(&mut out, spec.seed, plan.files)?,
        CorpusName::Dirty10k => write_dirty_base(&mut out, plan.files)?,
        CorpusName::Diff50k => write_diff_base(&mut out, spec.seed, plan.lines)?,
        CorpusName::CrlfUnicode => write_crlf_unicode(&mut out, spec.seed)?,
        CorpusName::Worktrees => write_worktrees_base(&mut out, spec.seed, plan)?,
    }
    out.flush()
}

fn write_data(out: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    writeln!(out, "data {}", bytes.len())?;
    out.write_all(bytes)?;
    // The LF terminating a data command is optional but unambiguous.
    out.write_all(b"\n")
}

fn write_commit_header(
    out: &mut impl Write,
    reference: &str,
    mark: u64,
    timestamp: i64,
    from: Option<u64>,
    merges: &[u64],
    message: &str,
) -> std::io::Result<()> {
    writeln!(out, "commit {reference}")?;
    writeln!(out, "mark :{mark}")?;
    writeln!(out, "author {IDENTITY} {timestamp} +0000")?;
    writeln!(out, "committer {IDENTITY} {timestamp} +0000")?;
    write_data(out, message.as_bytes())?;
    if let Some(from) = from {
        writeln!(out, "from :{from}")?;
    }
    for merge in merges {
        writeln!(out, "merge :{merge}")?;
    }
    Ok(())
}

fn write_file(out: &mut impl Write, path: &str, content: &[u8]) -> std::io::Result<()> {
    writeln!(out, "M 100644 inline {path}")?;
    write_data(out, content)
}

fn mix(seed: u64, value: u64) -> u64 {
    let mut state = seed ^ value.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    state ^= state >> 30;
    state = state.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    state ^= state >> 27;
    state = state.wrapping_mul(0x94D0_49BB_1331_11EB);
    state ^ (state >> 31)
}

fn write_linear(out: &mut impl Write, seed: u64, commits: u64) -> std::io::Result<()> {
    for index in 0..commits {
        let mark = index + 1;
        write_commit_header(
            out,
            "refs/heads/main",
            mark,
            BASE_EPOCH + index as i64,
            (index > 0).then(|| mark - 1),
            &[],
            &format!("bench: commit {index}\n"),
        )?;

        // Bounded growth: the file gains lines up to a cap so the stream stays
        // linear in the commit count instead of quadratic.
        let lines = if commits > 200_000 {
            4 + (index % 9) as usize
        } else {
            8 + (index % 57) as usize
        };
        let mut content = String::with_capacity(lines * 32 + 32);
        content.push_str(&format!("commit {index} seed {seed}\n"));
        for line in 0..lines {
            content.push_str(&format!(
                "line {line:04} {:016x}\n",
                mix(seed, index * 131 + line as u64)
            ));
        }
        write_file(out, "history.txt", content.as_bytes())?;
    }
    Ok(())
}

fn write_branches(out: &mut impl Write, seed: u64, plan: &Plan) -> std::io::Result<()> {
    for index in 0..plan.commits {
        let mark = index + 1;
        write_commit_header(
            out,
            "refs/heads/main",
            mark,
            BASE_EPOCH + index as i64,
            (index > 0).then(|| mark - 1),
            &[],
            &format!("bench: base commit {index}\n"),
        )?;
        if index == 0 {
            for file in 0..plan.files {
                write_file(
                    out,
                    &format!("f{file:02}.txt"),
                    format!("file {file} seed {seed}\n").as_bytes(),
                )?;
            }
        } else {
            let file = index % plan.files;
            write_file(
                out,
                &format!("f{file:02}.txt"),
                format!("file {file} commit {index}\n").as_bytes(),
            )?;
        }
    }

    for branch in 0..plan.branches {
        let target = (branch % plan.commits) + 1;
        writeln!(out, "reset refs/heads/branch-{branch:05}")?;
        writeln!(out, "from :{target}")?;
        writeln!(out)?;
    }
    for tag in 0..plan.tags {
        let target = (tag % plan.commits) + 1;
        writeln!(out, "reset refs/tags/v-{tag:05}")?;
        writeln!(out, "from :{target}")?;
        writeln!(out)?;
    }
    for remote in 0..plan.remotes {
        let target = (remote % plan.commits) + 1;
        writeln!(out, "reset refs/remotes/origin/branch-{remote:05}")?;
        writeln!(out, "from :{target}")?;
        writeln!(out)?;
    }
    Ok(())
}

fn write_merges(out: &mut impl Write, plan: &Plan) -> std::io::Result<()> {
    let mut mark = 1;
    write_commit_header(
        out,
        "refs/heads/main",
        mark,
        BASE_EPOCH,
        None,
        &[],
        "bench: merge base\n",
    )?;
    write_file(out, "merge.txt", b"base\n")?;
    let mut previous = mark;

    for level in 0..plan.depth {
        let timestamp = BASE_EPOCH + (level as i64 + 1) * 2;
        mark += 1;
        let side = mark;
        write_commit_header(
            out,
            &format!("refs/heads/side-{level:04}"),
            side,
            timestamp,
            Some(previous),
            &[],
            &format!("bench: side {level}\n"),
        )?;
        write_file(out, "merge.txt", format!("side {level}\n").as_bytes())?;

        mark += 1;
        let merge = mark;
        write_commit_header(
            out,
            "refs/heads/main",
            merge,
            timestamp + 1,
            Some(previous),
            &[side],
            &format!("bench: merge {level}\n"),
        )?;
        write_file(out, "merge.txt", format!("merge {level}\n").as_bytes())?;
        previous = merge;
    }
    Ok(())
}

fn write_wide(out: &mut impl Write, seed: u64, files: u64) -> std::io::Result<()> {
    write_commit_header(
        out,
        "refs/heads/main",
        1,
        BASE_EPOCH,
        None,
        &[],
        "bench: wide tree\n",
    )?;
    for index in 0..files {
        let directory = index % 64;
        let sub = (index / 64) % 16;
        let path = format!("d{directory:02}/s{sub:02}/f{index:06}.txt");
        let content = format!("file {index} {:016x}\n", mix(seed, index));
        write_file(out, &path, content.as_bytes())?;
    }
    Ok(())
}

fn write_dirty_base(out: &mut impl Write, files: u64) -> std::io::Result<()> {
    write_commit_header(
        out,
        "refs/heads/main",
        1,
        BASE_EPOCH,
        None,
        &[],
        "bench: dirty base\n",
    )?;
    for index in 0..files {
        write_file(
            out,
            &dirty_path(index),
            format!("file {index}\nbench\n").as_bytes(),
        )?;
    }
    Ok(())
}

fn write_diff_base(out: &mut impl Write, seed: u64, lines: u64) -> std::io::Result<()> {
    write_commit_header(
        out,
        "refs/heads/main",
        1,
        BASE_EPOCH,
        None,
        &[],
        "bench: diff base\n",
    )?;
    let content = original_lines(seed, lines);
    write_file(out, "big.txt", content.as_bytes())
}

fn write_crlf_unicode(out: &mut impl Write, seed: u64) -> std::io::Result<()> {
    write_commit_header(
        out,
        "refs/heads/main",
        1,
        BASE_EPOCH,
        None,
        &[],
        "bench: crlf and unicode\n",
    )?;
    write_file(out, "crlf.txt", b"premiere ligne\r\ndeuxieme ligne\r\n")?;
    write_file(out, "no-newline.txt", b"pas de saut de ligne final")?;
    write_file(
        out,
        "dossier-é/日本語.txt",
        format!("unicode seed {seed}\r\nligne suivante\r\n").as_bytes(),
    )?;
    write_file(out, "mixed.txt", b"a\r\nb\nc\r\nd\n")?;
    Ok(())
}

fn write_worktrees_base(out: &mut impl Write, seed: u64, plan: &Plan) -> std::io::Result<()> {
    for index in 0..plan.commits {
        let mark = index + 1;
        write_commit_header(
            out,
            "refs/heads/main",
            mark,
            BASE_EPOCH + index as i64,
            (index > 0).then(|| mark - 1),
            &[],
            &format!("bench: worktree base {index}\n"),
        )?;
        if index == 0 {
            for file in 0..plan.files {
                write_file(
                    out,
                    &format!("f{file:02}.txt"),
                    format!("file {file} seed {seed}\n").as_bytes(),
                )?;
            }
        } else {
            let file = index % plan.files;
            write_file(
                out,
                &format!("f{file:02}.txt"),
                format!("file {file} commit {index}\n").as_bytes(),
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Working tree post-processing
// ---------------------------------------------------------------------------

fn dirty_path(index: u64) -> String {
    format!("file-{index:05}.txt")
}

fn make_dirty(runner: &GitRunner, dir: &Path, plan: &Plan) -> Result<()> {
    let count = plan.files;
    let modified_end = (count / 3).max(1);
    let staged_end = ((count / 3) * 2).max(modified_end + 1).min(count);

    for index in 0..modified_end {
        fs::write(
            dir.join(dirty_path(index)),
            format!("file {index}\nbench\nmodified {index}\n"),
        )?;
    }

    let mut staged = Vec::new();
    for index in modified_end..staged_end {
        fs::write(
            dir.join(dirty_path(index)),
            format!("file {index}\nbench\nstaged {index}\n"),
        )?;
        staged.push(dirty_path(index));
    }
    for (chunk_index, chunk) in staged.chunks(400).enumerate() {
        let mut spec = CommandSpec::new(GitSubcommand::Add, dir);
        spec = spec.arg("--");
        for path in chunk {
            spec = spec.arg(path);
        }
        run(
            runner,
            with_identity(spec.timeout(MEDIUM_TIMEOUT), chunk_index as u64),
        )?;
    }

    for index in staged_end..count {
        fs::write(
            dir.join(format!("untracked-{index:05}.txt")),
            format!("untracked {index}\n"),
        )?;
    }
    Ok(())
}

fn original_lines(seed: u64, lines: u64) -> String {
    let mut content = String::with_capacity(lines as usize * 40);
    for index in 0..lines {
        content.push_str(&format!(
            "line {index:06} original {:016x}\n",
            mix(seed, index)
        ));
    }
    content
}

fn apply_diff_worktree(dir: &Path, plan: &Plan, seed: u64) -> Result<()> {
    let mut content = String::with_capacity(plan.lines as usize * 40);
    for index in 0..plan.lines {
        content.push_str(&format!(
            "line {index:06} changed {:016x}\n",
            mix(seed.wrapping_add(1), index)
        ));
    }
    fs::write(dir.join("big.txt"), content)?;
    Ok(())
}

fn create_worktrees(runner: &GitRunner, root: &Path, dir: &Path, plan: &Plan) -> Result<()> {
    let worktrees = worktree_root(root, CorpusName::Worktrees);
    fs::create_dir_all(&worktrees)?;
    for index in 0..plan.worktrees {
        let branch = format!("wt-{index}");
        let path = worktrees.join(&branch);
        let start = format!("main~{}", index * 3);
        run(
            runner,
            with_identity(
                CommandSpec::new(GitSubcommand::Worktree, dir)
                    .arg("add")
                    .arg("-b")
                    .arg(&branch)
                    .arg(&path)
                    .arg(&start)
                    .timeout(LONG_TIMEOUT),
                index,
            ),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream_for(spec: &CorpusSpec, plan: &Plan) -> Vec<u8> {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("stream");
        write_stream(&path, spec, plan).expect("write stream");
        fs::read(path).expect("read stream")
    }

    #[test]
    fn names_round_trip_and_are_kebab_case() {
        for name in CorpusName::ALL {
            assert_eq!(CorpusName::parse(name.as_str()), Some(name));
        }
        assert_eq!(CorpusName::Linear10k.as_str(), "linear-10k");
        assert_eq!(CorpusName::Branches5k.as_str(), "branches-5k");
        assert_eq!(CorpusName::parse("LINEAR-10K"), Some(CorpusName::Linear10k));
        assert_eq!(CorpusName::parse("unknown"), None);
    }

    #[test]
    fn linear_stream_is_deterministic_for_a_seed() {
        let plan = Plan::new(32, 1);
        let first = stream_for(&CorpusSpec::full(CorpusName::Linear10k, 7), &plan);
        let second = stream_for(&CorpusSpec::full(CorpusName::Linear10k, 7), &plan);
        let other = stream_for(&CorpusSpec::full(CorpusName::Linear10k, 8), &plan);
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(String::from_utf8_lossy(&first).contains("commit refs/heads/main"));
        assert!(String::from_utf8_lossy(&first).contains("author BeeBranch Bench"));
    }

    #[test]
    fn stream_uses_fixed_dates_and_identity() {
        let plan = Plan::new(2, 1);
        let stream = String::from_utf8_lossy(&stream_for(
            &CorpusSpec::full(CorpusName::Linear10k, 1),
            &plan,
        ))
        .into_owned();
        assert!(stream.contains(&format!("{BASE_EPOCH} +0000")));
        assert!(stream.contains(IDENTITY));
        assert!(!stream.contains("2026"));
    }

    #[test]
    fn reduced_scale_shrinks_ci_corpora() {
        let branches_full = sizes(&CorpusSpec::full(CorpusName::Branches5k, 1));
        let branches_reduced = sizes(&CorpusSpec::reduced(CorpusName::Branches5k, 1));
        assert_eq!(branches_full.commits, branches_reduced.commits);
        let diff_full = sizes(&CorpusSpec::full(CorpusName::Diff50k, 1));
        let diff_reduced = sizes(&CorpusSpec::reduced(CorpusName::Diff50k, 1));
        assert_eq!(diff_full.files, diff_reduced.files);

        let full_plan = plan(&CorpusSpec::full(CorpusName::Branches5k, 1));
        let reduced_plan = plan(&CorpusSpec::reduced(CorpusName::Branches5k, 1));
        assert_eq!(full_plan.branches, 5_000);
        assert_eq!(reduced_plan.branches, 500);
        assert_eq!(reduced_plan.remotes, 500);
        assert_eq!(reduced_plan.tags, 50);
    }

    #[test]
    fn reduced_diff_and_wide_use_fewer_lines_and_files() {
        let full = plan(&CorpusSpec::full(CorpusName::Diff50k, 1));
        let reduced = plan(&CorpusSpec::reduced(CorpusName::Diff50k, 1));
        assert_eq!(full.lines, 50_000);
        assert_eq!(reduced.lines, 5_000);

        let wide_full = sizes(&CorpusSpec::full(CorpusName::Wide200k, 1));
        let wide_reduced = sizes(&CorpusSpec::reduced(CorpusName::Wide200k, 1));
        assert_eq!(wide_full.files, 200_000);
        assert_eq!(wide_reduced.files, 20_000);

        let dirty_full = sizes(&CorpusSpec::full(CorpusName::Dirty10k, 1));
        let dirty_reduced = sizes(&CorpusSpec::reduced(CorpusName::Dirty10k, 1));
        assert_eq!(dirty_full.files, 10_000);
        assert_eq!(dirty_reduced.files, 2_000);

        let merges_full = sizes(&CorpusSpec::full(CorpusName::MergesDeep, 1));
        let merges_reduced = sizes(&CorpusSpec::reduced(CorpusName::MergesDeep, 1));
        assert_eq!(merges_full.commits, 2_001);
        assert_eq!(merges_reduced.commits, 401);
    }

    #[test]
    fn large_linear_corpus_keeps_normal_commit_count() {
        assert_eq!(
            sizes(&CorpusSpec::full(CorpusName::Linear100k, 1)).commits,
            100_000
        );
        assert_eq!(
            sizes(&CorpusSpec::full(CorpusName::Linear1m, 1)).commits,
            1_000_000
        );
    }

    #[test]
    fn marker_round_trips_and_mismatches() {
        let directory = tempfile::tempdir().expect("tempdir");
        let spec = CorpusSpec::full(CorpusName::CrlfUnicode, 42);
        let marker = CorpusMarker {
            schema: MARKER_SCHEMA,
            generator_version: GENERATOR_VERSION,
            name: spec.name.as_str().to_owned(),
            seed: spec.seed,
            scale: spec.scale.as_str().to_owned(),
            commits: 3,
            files: 4,
        };
        fs::create_dir_all(directory.path().join(".git")).expect("git dir");
        fs::write(
            marker_path(directory.path()),
            serde_json::to_string(&marker).expect("serialize"),
        )
        .expect("write marker");

        assert!(marker_matches(directory.path(), &spec).is_some());
        let other_seed = CorpusSpec::full(CorpusName::CrlfUnicode, 43);
        assert!(marker_matches(directory.path(), &other_seed).is_none());
        let reduced = CorpusSpec::reduced(CorpusName::CrlfUnicode, 42);
        assert!(marker_matches(directory.path(), &reduced).is_none());
    }

    #[test]
    fn scale_is_normalized_when_it_does_not_change_the_corpus() {
        let reduced = CorpusSpec::reduced(CorpusName::Linear10k, 1);
        assert_eq!(reduced.effective().scale, CorpusScale::Full);
        let reduced = CorpusSpec::reduced(CorpusName::Diff50k, 1);
        assert_eq!(reduced.effective().scale, CorpusScale::Reduced);
    }

    #[test]
    fn ensure_generates_then_reuses_a_small_corpus() {
        let directory = tempfile::tempdir().expect("tempdir");
        let spec = CorpusSpec::full(CorpusName::CrlfUnicode, 7);
        assert!(!Corpus::is_ready(directory.path(), &spec));

        let generated = Corpus::ensure(directory.path(), &spec).expect("generate corpus");
        assert!(!generated.reused);
        assert_eq!(generated.commits, 1);
        assert_eq!(generated.files, 4);
        assert!(directory.path().join("crlf-unicode/crlf.txt").is_file());
        assert!(directory
            .path()
            .join("crlf-unicode/dossier-é/日本語.txt")
            .is_file());
        assert!(Corpus::is_ready(directory.path(), &spec));

        let reused = Corpus::ensure(directory.path(), &spec).expect("reuse corpus");
        assert!(reused.reused);
        assert_eq!(reused.commits, 1);
    }

    #[test]
    fn is_ready_is_false_without_marker() {
        let directory = tempfile::tempdir().expect("tempdir");
        let spec = CorpusSpec::full(CorpusName::Linear10k, 42);
        assert!(!Corpus::is_ready(directory.path(), &spec));
    }

    #[test]
    fn worktree_root_is_a_sibling_of_the_corpus() {
        let root = Path::new("/tmp/bench");
        assert_eq!(
            worktree_root(root, CorpusName::Worktrees),
            Path::new("/tmp/bench/worktrees-linked")
        );
    }

    #[test]
    fn data_blocks_are_exact_for_binary_safe_content() {
        let mut buffer = Vec::new();
        write_data(&mut buffer, b"a\r\nb").expect("write");
        assert_eq!(buffer, b"data 4\na\r\nb\n");
    }
}
