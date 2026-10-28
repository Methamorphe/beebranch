//! Repository sessions: discovery, state, generation, mutation queue and
//! targeted invalidation from the filesystem watcher.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory, Page, PageRequest, RepoId, RepoState};
use notify::{RecursiveMode, Watcher as _};
use serde::{Deserialize, Serialize};

use crate::commit::{read_commit, CommitDetail};
use crate::diff::{read_diff, DiffLimits, DiffReport, DiffTarget};
use crate::discover::{discover, RepoDiscovery};
use crate::graph::{GraphPager, GraphRow};
use crate::log::{read_log, read_log_scoped, CommitSummary, LogStream};
use crate::process::GitRunner;
use crate::refs::{read_refs, RefsSnapshot};
use crate::state::{detect, DetectedState};
use crate::status::StatusReport;

/// Default watcher debounce.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(150);

/// Cached areas invalidated by a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvalidationArea {
    Refs,
    Index,
    Worktree,
    Head,
    State,
    Busy,
    Config,
}

impl InvalidationArea {
    pub const ALL: [Self; 6] = [
        Self::Refs,
        Self::Index,
        Self::Worktree,
        Self::Head,
        Self::State,
        Self::Busy,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChange {
    pub repo_id: RepoId,
    pub generation: u64,
    pub areas: Vec<InvalidationArea>,
}

pub type ChangeSink = Arc<dyn Fn(RepoChange) + Send + Sync>;

/// Session configuration.
#[derive(Clone, Default)]
pub struct SessionOptions {
    pub sink: Option<ChangeSink>,
    pub debounce: Option<Duration>,
    pub max_status_entries: Option<usize>,
}

impl std::fmt::Debug for SessionOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionOptions")
            .field("has_sink", &self.sink.is_some())
            .field("debounce", &self.debounce)
            .field("max_status_entries", &self.max_status_entries)
            .finish()
    }
}

type MutationResult = Result<Vec<InvalidationArea>, AppError>;
pub type MutationJob =
    Box<dyn FnOnce(&GitRunner, &RepoDiscovery) -> MutationResult + Send + 'static>;

struct MutationEnvelope {
    job: MutationJob,
    done: Sender<Result<u64, AppError>>,
}

struct MutationQueue {
    sender: Mutex<Option<Sender<MutationEnvelope>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl MutationQueue {
    fn start(
        runner: GitRunner,
        discovery: RepoDiscovery,
        repo_id: RepoId,
        generation: Arc<AtomicU64>,
        sink: Option<ChangeSink>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel::<MutationEnvelope>();
        let worker = thread::Builder::new()
            .name(format!("beebranch-mutations-{}", repo_id.as_str()))
            .spawn(move || worker_loop(runner, discovery, repo_id, generation, sink, receiver))
            .ok();

        Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(worker),
        }
    }

    fn submit(&self, job: MutationJob) -> Result<Result<u64, AppError>, AppError> {
        let (done, receiver) = mpsc::channel();
        {
            let sender = self.sender.lock().map_err(lock_error)?;
            let sender = sender.as_ref().ok_or_else(|| {
                AppError::new(
                    "repo.closed",
                    ErrorCategory::Repo,
                    "La session de dépôt est fermée.",
                )
            })?;
            sender.send(MutationEnvelope { job, done }).map_err(|_| {
                AppError::new(
                    "repo.closed",
                    ErrorCategory::Repo,
                    "La file de mutations est fermée.",
                )
            })?;
        }
        receiver.recv().map_err(|_| {
            AppError::new(
                "app.internal",
                ErrorCategory::Internal,
                "La mutation n'a pas renvoyé de résultat.",
            )
        })
    }

    fn shutdown(&self) {
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

fn worker_loop(
    runner: GitRunner,
    discovery: RepoDiscovery,
    repo_id: RepoId,
    generation: Arc<AtomicU64>,
    sink: Option<ChangeSink>,
    receiver: Receiver<MutationEnvelope>,
) {
    while let Ok(envelope) = receiver.recv() {
        let result = (envelope.job)(&runner, &discovery);
        let generation = generation.fetch_add(1, Ordering::AcqRel) + 1;
        let areas = match &result {
            Ok(areas) if !areas.is_empty() => areas.clone(),
            _ => InvalidationArea::ALL.to_vec(),
        };
        if let Some(sink) = &sink {
            sink(RepoChange {
                repo_id: repo_id.clone(),
                generation,
                areas,
            });
        }
        let answer = match result {
            Ok(_) => Ok(generation),
            Err(error) => Err(error),
        };
        let _ = envelope.done.send(answer);
    }
}

struct WatcherGuard {
    watcher: Option<notify::RecommendedWatcher>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WatcherGuard {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.watcher.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One open repository worktree.
pub struct RepoSession {
    id: RepoId,
    discovery: RepoDiscovery,
    runner: GitRunner,
    generation: Arc<AtomicU64>,
    state: RwLock<RepoState>,
    locks: RwLock<Vec<PathBuf>>,
    graph: Mutex<GraphPager>,
    log_stream: Mutex<Option<LogStream>>,
    queue: MutationQueue,
    watcher: Mutex<Option<WatcherGuard>>,
    sink: Option<ChangeSink>,
}

impl std::fmt::Debug for RepoSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepoSession")
            .field("id", &self.id)
            .field("worktree", &self.discovery.worktree)
            .field("generation", &self.generation.load(Ordering::Acquire))
            .finish()
    }
}

impl RepoSession {
    /// Open a worktree session. Bare repositories and `.git` directories are
    /// refused with `repo.bare`.
    pub fn open(
        runner: &GitRunner,
        path: impl AsRef<Path>,
        options: SessionOptions,
    ) -> Result<Self, AppError> {
        let discovery = discover(runner, path)?;
        let worktree = discovery.worktree()?.to_path_buf();
        let id = RepoId::from_path(&worktree);
        let detected = detect(runner, &discovery, options.max_status_entries)?;

        let debounce = options.debounce.unwrap_or(DEFAULT_DEBOUNCE);
        let generation = Arc::new(AtomicU64::new(1));
        let sink = options.sink.clone();

        let queue = MutationQueue::start(
            runner.clone(),
            discovery.clone(),
            id.clone(),
            generation.clone(),
            sink.clone(),
        );

        let session = Self {
            id,
            discovery: discovery.clone(),
            runner: runner.clone(),
            generation,
            state: RwLock::new(detected.state),
            locks: RwLock::new(detected.locks),
            graph: Mutex::new(GraphPager::new()),
            log_stream: Mutex::new(None),
            queue,
            watcher: Mutex::new(None),
            sink,
        };

        let watcher = start_watcher(&session, debounce)
            .map_err(|error| AppError::internal(format!("watcher: {error}")))?;
        if let Ok(mut slot) = session.watcher.lock() {
            *slot = watcher;
        }
        Ok(session)
    }

    pub fn id(&self) -> &RepoId {
        &self.id
    }

    pub fn discovery(&self) -> &RepoDiscovery {
        &self.discovery
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    pub fn worktree(&self) -> &Path {
        self.discovery
            .worktree
            .as_deref()
            .expect("session requires a worktree")
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn state(&self) -> RepoState {
        self.state
            .read()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    pub fn locks(&self) -> Vec<PathBuf> {
        self.locks
            .read()
            .map(|locks| locks.clone())
            .unwrap_or_default()
    }

    /// Recompute the structural state without incrementing the generation.
    pub fn refresh_state(&self) -> Result<RepoState, AppError> {
        let detected = detect(&self.runner, &self.discovery, None)?;
        self.store_detected(&detected);
        Ok(detected.state)
    }

    fn store_detected(&self, detected: &DetectedState) {
        if let Ok(mut state) = self.state.write() {
            *state = detected.state.clone();
        }
        if let Ok(mut locks) = self.locks.write() {
            *locks = detected.locks.clone();
        }
    }

    /// Submit a mutation. Mutations are serialized per repository; the
    /// returned generation is the one produced by the mutation.
    pub fn mutate<F>(&self, job: F) -> Result<u64, AppError>
    where
        F: FnOnce(&GitRunner, &RepoDiscovery) -> MutationResult + Send + 'static,
    {
        self.queue.submit(Box::new(job))?
    }

    /// Force an invalidation (manual refresh, post-operation).
    pub fn invalidate(&self, areas: Vec<InvalidationArea>) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(sink) = &self.sink {
            sink(RepoChange {
                repo_id: self.id.clone(),
                generation,
                areas,
            });
        }
        generation
    }

    pub fn status(&self, max_entries: Option<usize>) -> Result<(StatusReport, u64), AppError> {
        self.status_opts(max_entries, false)
    }

    pub fn status_opts(
        &self,
        max_entries: Option<usize>,
        include_ignored: bool,
    ) -> Result<(StatusReport, u64), AppError> {
        let generation = self.generation();
        Ok((
            crate::status::read_status_opts(
                &self.runner,
                self.worktree(),
                max_entries,
                include_ignored,
            )?,
            generation,
        ))
    }

    pub fn refs(&self) -> Result<(RefsSnapshot, u64), AppError> {
        let generation = self.generation();
        Ok((read_refs(&self.runner, self.worktree())?, generation))
    }

    pub fn log(
        &self,
        request: &PageRequest,
        revision: Option<&str>,
    ) -> Result<Page<CommitSummary>, AppError> {
        let generation = self.generation();
        read_log(&self.runner, self.worktree(), request, revision, generation)
    }

    /// Read a log page including every ref (stash, tags, remotes).
    pub fn log_scoped(
        &self,
        request: &PageRequest,
        revision: Option<&str>,
        all_refs: bool,
    ) -> Result<Page<CommitSummary>, AppError> {
        let generation = self.generation();
        read_log_scoped(
            &self.runner,
            self.worktree(),
            request,
            revision,
            all_refs,
            generation,
        )
    }

    /// Read a log page together with lane rows for the graph.
    pub fn graph_page(
        &self,
        request: &PageRequest,
        revision: Option<&str>,
    ) -> Result<(Page<CommitSummary>, Vec<GraphRow>), AppError> {
        self.graph_page_scoped(request, revision, false)
    }

    /// Graph page with optional all-refs inclusion (stash visibility).
    pub fn graph_page_scoped(
        &self,
        request: &PageRequest,
        revision: Option<&str>,
        all_refs: bool,
    ) -> Result<(Page<CommitSummary>, Vec<GraphRow>), AppError> {
        let generation = self.generation();
        let page = {
            let mut guard = self.log_stream.lock().map_err(lock_error)?;
            if request.after.is_none() {
                *guard = None;
            }
            if guard.is_none() {
                *guard = Some(LogStream::start(
                    &self.runner,
                    self.worktree(),
                    revision,
                    all_refs,
                    generation,
                )?);
            }
            let streamed = guard
                .as_mut()
                .map(|stream| stream.page(request, revision, all_refs, generation))
                .transpose()?
                .flatten();
            match streamed {
                Some(page) => page,
                None => {
                    *guard = None;
                    read_log_scoped(
                        &self.runner,
                        self.worktree(),
                        request,
                        revision,
                        all_refs,
                        generation,
                    )?
                }
            }
        };
        let rows = {
            let mut pager = self.graph.lock().map_err(lock_error)?;
            pager.rows(
                request.after.as_deref(),
                generation,
                &page.items,
                page.next.as_deref(),
            )
        };
        Ok((page, rows))
    }

    pub fn commit(&self, sha: &str) -> Result<CommitDetail, AppError> {
        read_commit(&self.runner, self.worktree(), sha)
    }

    pub fn diff(
        &self,
        target: &DiffTarget,
        paths: &[String],
        limits: DiffLimits,
    ) -> Result<DiffReport, AppError> {
        read_diff(&self.runner, self.worktree(), target, paths, limits)
    }

    pub fn shutdown(&self) {
        if let Ok(mut stream) = self.log_stream.lock() {
            stream.take();
        }
        self.queue.shutdown();
        if let Ok(mut slot) = self.watcher.lock() {
            if let Some(mut watcher) = slot.take() {
                watcher.stop();
            }
        }
    }
}

impl Drop for RepoSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn start_watcher(
    session: &RepoSession,
    debounce: Duration,
) -> Result<Option<WatcherGuard>, notify::Error> {
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })?;

    let worktree = session.worktree().to_path_buf();
    watcher.watch(&worktree, RecursiveMode::Recursive)?;
    let git_dir = session.discovery.git_dir.clone();
    let common_dir = session.discovery.common_dir.clone();
    watcher.watch(&git_dir, RecursiveMode::Recursive)?;
    if common_dir != git_dir {
        watcher.watch(&common_dir, RecursiveMode::Recursive)?;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let worktree_for_thread = worktree;
    let repo_id = session.id.clone();
    let generation = session.generation.clone();
    let sink = session.sink.clone();

    let thread = thread::Builder::new()
        .name(format!("beebranch-watcher-{}", repo_id.as_str()))
        .spawn(move || {
            let mut areas: Vec<InvalidationArea> = Vec::new();
            while !stop_flag.load(Ordering::SeqCst) {
                match receiver.recv_timeout(debounce) {
                    Ok(Ok(event)) => {
                        for path in event.paths {
                            for area in
                                areas_for(&path, &git_dir, &common_dir, &worktree_for_thread)
                            {
                                if !areas.contains(&area) {
                                    areas.push(area);
                                }
                            }
                        }
                        continue;
                    }
                    Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if !areas.is_empty() && !stop_flag.load(Ordering::SeqCst) {
                    areas.sort_by_key(|area| *area as u8);
                    let generation = generation.fetch_add(1, Ordering::AcqRel) + 1;
                    if let Some(sink) = &sink {
                        sink(RepoChange {
                            repo_id: repo_id.clone(),
                            generation,
                            areas: std::mem::take(&mut areas),
                        });
                    } else {
                        areas.clear();
                    }
                }
            }
        })
        .map_err(|error| notify::Error::io(std::io::Error::other(error)))?;

    Ok(Some(WatcherGuard {
        watcher: Some(watcher),
        stop,
        thread: Some(thread),
    }))
}

fn areas_for(
    path: &Path,
    git_dir: &Path,
    common_dir: &Path,
    worktree: &Path,
) -> Vec<InvalidationArea> {
    if let Ok(relative) = path.strip_prefix(git_dir) {
        return git_areas(relative);
    }
    if common_dir != git_dir {
        if let Ok(relative) = path.strip_prefix(common_dir) {
            return git_areas(relative);
        }
    }
    if let Ok(relative) = path.strip_prefix(worktree) {
        if let Ok(inner) = relative.strip_prefix(".git") {
            return git_areas(inner);
        }
        // A worktree write changes the staged/unstaged/untracked summary and
        // the conflict set carried by `RepoState`, not just the worktree read
        // model: both must be recomputed without waiting for a manual refresh.
        return vec![InvalidationArea::Worktree, InvalidationArea::State];
    }
    Vec::new()
}

fn git_areas(relative: &Path) -> Vec<InvalidationArea> {
    let first = relative
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default();
    match first.as_str() {
        "HEAD" => vec![InvalidationArea::Head],
        // Staging changes the staged/unstaged split cached in `RepoState`.
        "index" => vec![InvalidationArea::Index, InvalidationArea::State],
        "index.lock" | "HEAD.lock" => vec![InvalidationArea::Busy],
        "refs" | "packed-refs" => vec![InvalidationArea::Refs],
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "rebase-merge" | "rebase-apply"
        | "sequencer" | "BISECT_LOG" | "BISECT_START" => {
            vec![InvalidationArea::State]
        }
        "config" => vec![InvalidationArea::Config],
        "worktrees" => vec![InvalidationArea::Refs, InvalidationArea::State],
        // Object/log churn does not invalidate any read model.
        _ => Vec::new(),
    }
}

fn lock_error<T>(_: T) -> AppError {
    AppError::internal("un verrou de session est empoisonné")
}

/// Registry of open sessions.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<RepoId, Arc<RepoSession>>>,
}

impl std::fmt::Debug for SessionRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRegistry")
            .field("count", &self.len())
            .finish()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open or reuse a session for the same worktree.
    pub fn open(
        &self,
        runner: &GitRunner,
        path: impl AsRef<Path>,
        options: SessionOptions,
    ) -> Result<(Arc<RepoSession>, bool), AppError> {
        let worktree = std::fs::canonicalize(path.as_ref()).map_err(|error| {
            AppError::new(
                "repo.not_git",
                ErrorCategory::Repo,
                "Le dossier n'existe pas.",
            )
            .with_detail(error.to_string())
        })?;
        let id = RepoId::from_path(&worktree);
        if let Some(session) = self.get(&id) {
            return Ok((session, false));
        }
        let session = Arc::new(RepoSession::open(runner, &worktree, options)?);
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if let Some(existing) = sessions.get(&id) {
            return Ok((existing.clone(), false));
        }
        sessions.insert(id, session.clone());
        Ok((session, true))
    }

    pub fn get(&self, id: &RepoId) -> Option<Arc<RepoSession>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(id).cloned())
    }

    pub fn close(&self, id: &RepoId) -> bool {
        let removed = self
            .sessions
            .lock()
            .map(|mut sessions| sessions.remove(id))
            .ok()
            .flatten();
        match removed {
            Some(session) => {
                session.shutdown();
                true
            }
            None => false,
        }
    }

    pub fn list(&self) -> Vec<Arc<RepoSession>> {
        self.sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn close_all(&self) {
        let sessions: Vec<Arc<RepoSession>> = {
            let mut lock = match self.sessions.lock() {
                Ok(lock) => lock,
                Err(_) => return,
            };
            lock.drain().map(|(_, session)| session).collect()
        };
        for session in sessions {
            session.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    fn fixture() -> (tempfile::TempDir, GitRunner) {
        let dir = tempfile::tempdir().expect("tempdir");
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.email", "a@b.c"]);
        git(dir.path(), &["config", "user.name", "Alice"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "first"]);
        let runner = GitRunner::detect().expect("git");
        (dir, runner)
    }

    #[test]
    fn opens_and_closes_a_session() {
        let (dir, runner) = fixture();
        let registry = SessionRegistry::new();
        let (session, created) = registry
            .open(&runner, dir.path(), SessionOptions::default())
            .expect("open");
        assert!(created);
        assert_eq!(session.state().worktree.untracked, 0);
        assert_eq!(registry.len(), 1);

        assert!(registry.close(session.id()));
        assert!(registry.is_empty());
    }

    #[test]
    fn refuses_bare_repositories() {
        let dir = tempfile::tempdir().expect("tempdir");
        git(dir.path(), &["init", "-q", "--bare"]);
        let runner = GitRunner::detect().expect("git");
        let error = RepoSession::open(&runner, dir.path(), SessionOptions::default())
            .expect_err("bare must be refused");
        assert_eq!(error.code, "repo.bare");
    }

    #[test]
    fn serializes_mutations_and_increments_generation() {
        let (dir, runner) = fixture();
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("open");
        let start = session.generation();
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = order.clone();
        let second = order.clone();

        session
            .mutate(move |_runner, _discovery| {
                first.lock().unwrap().push(1);
                Ok(Vec::new())
            })
            .expect("first");
        session
            .mutate(move |_runner, _discovery| {
                second.lock().unwrap().push(2);
                Ok(Vec::new())
            })
            .expect("second");

        assert_eq!(*order.lock().unwrap(), vec![1, 2]);
        assert_eq!(session.generation(), start + 2);
    }

    fn wait_for_areas(
        receiver: &Receiver<RepoChange>,
        wanted: &[InvalidationArea],
    ) -> Option<RepoChange> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(change) = receiver.recv_timeout(Duration::from_millis(100)) {
                if wanted.iter().all(|area| change.areas.contains(area)) {
                    return Some(change);
                }
            }
        }
        None
    }

    #[test]
    fn external_change_invalidates_the_worktree() {
        let (dir, runner) = fixture();
        let (sender, receiver) = mpsc::channel();
        let sink: ChangeSink = Arc::new(move |change| {
            let _ = sender.send(change);
        });
        let session = RepoSession::open(
            &runner,
            dir.path(),
            SessionOptions {
                sink: Some(sink),
                debounce: Some(Duration::from_millis(30)),
                max_status_entries: None,
            },
        )
        .expect("open");

        std::fs::write(dir.path().join("watched.txt"), "change").expect("write");
        let change = wait_for_areas(
            &receiver,
            &[InvalidationArea::Worktree, InvalidationArea::State],
        )
        .expect("watcher must report a worktree change with the state area");
        assert_eq!(
            change.areas,
            vec![InvalidationArea::Worktree, InvalidationArea::State],
            "a worktree write must also invalidate the cached repository state"
        );
        session.shutdown();
    }

    #[test]
    fn external_staging_invalidates_the_index_and_state() {
        let (dir, runner) = fixture();
        let (sender, receiver) = mpsc::channel();
        let sink: ChangeSink = Arc::new(move |change| {
            let _ = sender.send(change);
        });
        let session = RepoSession::open(
            &runner,
            dir.path(),
            SessionOptions {
                sink: Some(sink),
                debounce: Some(Duration::from_millis(30)),
                max_status_entries: None,
            },
        )
        .expect("open");

        std::fs::write(dir.path().join("a.txt"), "two\n").expect("write");
        git(dir.path(), &["add", "a.txt"]);
        assert!(
            wait_for_areas(
                &receiver,
                &[InvalidationArea::Index, InvalidationArea::State]
            )
            .is_some(),
            "staging outside the application must invalidate the index and the state"
        );
        session.shutdown();
    }

    #[test]
    fn closing_rejects_new_mutations() {
        let (dir, runner) = fixture();
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("open");
        session.shutdown();
        let error = session
            .mutate(|_runner, _discovery| Ok(Vec::new()))
            .expect_err("closed");
        assert_eq!(error.code, "repo.closed");
    }
}
