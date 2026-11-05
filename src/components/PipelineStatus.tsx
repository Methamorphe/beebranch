import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { errorMessage } from '../ipc/client'
import { openExternalUrl, pipelineJobs, pipelineOverview, pipelineRecent } from '../ipc/commands'
import {
  aggregatePipelineState,
  isSettled,
  PIPELINE_STATE_KEYS,
  pipelineRefLabel,
  pipelineState,
} from '../lib/pipeline'
import type { GitlabPipeline, PipelineJob, PipelineOverview } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './PipelineStatus.module.css'

/** Slow enough to stay polite with the forge, fast enough to follow a run. */
const REFRESH_MS = 30_000

type Props = {
  repoId: string | null
  /** Repository generation: any state change reloads the commit pipelines. */
  generation: number
}

/** Commit pipelines or the whole project's recent pipelines. */
type Scope = 'commit' | 'repository'

type EntriesProps = {
  pipelines: GitlabPipeline[]
  empty: string
  /** Repository scope names the ref and the commit of every pipeline. */
  showRef: boolean
  expanded: number | null
  jobs: Record<number, PipelineJob[]>
  jobsBusy: boolean
  onToggle: (pipeline: GitlabPipeline) => void
}

function PipelineEntries({ pipelines, empty, showRef, expanded, jobs, jobsBusy, onToggle }: EntriesProps) {
  const { t } = useI18n()
  if (pipelines.length === 0) {
    return <p className={styles.hint}>{empty}</p>
  }
  return (
    <ul className={styles.list}>
      {pipelines.map((pipeline) => {
        const itemState = pipelineState(pipeline.status)
        const open = expanded === pipeline.id
        const items = jobs[pipeline.id]
        return (
          <li key={pipeline.id} className={styles.entry}>
            <div className={styles.row}>
              <button
                type="button"
                className={styles.entryButton}
                aria-expanded={open}
                onClick={() => onToggle(pipeline)}
              >
                <span className={styles.dot} data-state={itemState} />
                {showRef ? (
                  <>
                    <span className={styles.ref} title={pipeline.refName ?? undefined}>
                      {pipelineRefLabel(pipeline.refName) ?? t('shell.pipeline.detached')}
                    </span>
                    <span className={styles.mono}>#{pipeline.id}</span>
                    {pipeline.sha ? (
                      <span className={styles.mono}>{pipeline.sha.slice(0, 10)}</span>
                    ) : null}
                  </>
                ) : (
                  <span className={styles.entryName}>
                    {pipeline.detailedStatus ?? `#${pipeline.id}`}
                  </span>
                )}
                <span className={styles.entryState}>{t(PIPELINE_STATE_KEYS[itemState])}</span>
              </button>
              {pipeline.webUrl ? (
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => void openExternalUrl(pipeline.webUrl!)}
                >
                  {t('common.open')}
                </button>
              ) : null}
            </div>
            {open ? (
              <div className={styles.jobs}>
                {jobsBusy && !items ? (
                  <p className={styles.hint}>{t('shell.pipeline.refreshing')}</p>
                ) : items && items.length > 0 ? (
                  <ul className={styles.jobList}>
                    {items.map((job) => {
                      const jobState = pipelineState(job.status)
                      return (
                        <li key={job.id} className={styles.job}>
                          <span className={styles.dot} data-state={jobState} />
                          <span className={styles.jobName}>
                            {job.stage ? `${job.stage} / ` : ''}
                            {job.name}
                          </span>
                          <span className={styles.entryState}>{t(PIPELINE_STATE_KEYS[jobState])}</span>
                          {job.duration !== undefined ? (
                            <span className={styles.mono}>{Math.round(job.duration)} s</span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className={styles.hint}>{t('shell.pipeline.noJobs')}</p>
                )}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * CI state of the active repository.
 *
 * The trigger keeps the checked-out commit's state; the panel lists either that
 * commit's pipelines or the project's recent pipelines across every ref, so a
 * run on another branch is never invisible. Renders nothing until a forge
 * project is linked and connected: the indicator is repo-scoped chrome, not a
 * session-wide status.
 */
export function PipelineStatus({ repoId, generation }: Props) {
  const { t } = useI18n()
  const [scope, setScope] = useState<Scope>('commit')
  const [overview, setOverview] = useState<PipelineOverview | null>(null)
  const [recent, setRecent] = useState<GitlabPipeline[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [recentRefreshing, setRecentRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [jobs, setJobs] = useState<Record<number, PipelineJob[]>>({})
  const [jobsBusy, setJobsBusy] = useState(false)
  const request = useRef(0)
  const recentRequest = useRef(0)

  const load = useCallback(async () => {
    if (!repoId) return
    const id = ++request.current
    setRefreshing(true)
    try {
      const next = await pipelineOverview(repoId)
      if (id !== request.current) return
      setOverview(next)
      setError(null)
    } catch (cause) {
      if (id !== request.current) return
      // Keep the last known state: a transient failure must not make the
      // indicator blink out of the toolbar.
      setError(errorMessage(cause))
    } finally {
      if (id === request.current) setRefreshing(false)
    }
  }, [repoId])

  const loadRecent = useCallback(async () => {
    if (!repoId) return
    const id = ++recentRequest.current
    setRecentRefreshing(true)
    try {
      const next = await pipelineRecent(repoId)
      if (id !== recentRequest.current) return
      setRecent(next)
      setError(null)
    } catch (cause) {
      if (id !== recentRequest.current) return
      setError(errorMessage(cause))
    } finally {
      if (id === recentRequest.current) setRecentRefreshing(false)
    }
  }, [repoId])

  const loadJobs = useCallback(
    async (pipelineId: number) => {
      if (!repoId) return
      setJobsBusy(true)
      try {
        const items = await pipelineJobs(repoId, pipelineId)
        setJobs((current) => ({ ...current, [pipelineId]: items }))
      } catch {
        // The overview already surfaces connection failures.
      } finally {
        setJobsBusy(false)
      }
    },
    [repoId],
  )

  useEffect(() => {
    setOverview(null)
    setError(null)
    setExpanded(null)
    setJobs({})
    void load()
  }, [load, generation])

  useEffect(() => {
    if (scope === 'repository') void loadRecent()
  }, [scope, loadRecent])

  useEffect(() => {
    if (!repoId) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      if (scope === 'repository') {
        void loadRecent()
      } else {
        void load()
      }
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [repoId, load, loadRecent, scope])

  // A poll may have changed the run behind the open panel: refresh its jobs.
  useEffect(() => {
    if (expanded !== null) void loadJobs(expanded)
  }, [expanded, overview, recent, loadJobs])

  if (!overview) return null

  const pipelines = overview.pipelines
  const state = aggregatePipelineState(pipelines.map((pipeline) => pipeline.status))
  const settled = pipelines.filter((pipeline) => isSettled(pipelineState(pipeline.status))).length
  const provider = overview.provider === 'github' ? 'GitHub' : 'GitLab'
  const stateLabel = t(PIPELINE_STATE_KEYS[state])
  const openTarget =
    scope === 'repository'
      ? (recent?.[0]?.webUrl ?? overview.projectWebUrl)
      : (pipelines[0]?.webUrl ?? overview.projectWebUrl)
  const busyRefresh = scope === 'repository' ? recentRefreshing : refreshing

  const toggle = (pipeline: GitlabPipeline) => {
    if (expanded === pipeline.id) {
      setExpanded(null)
      return
    }
    setExpanded(pipeline.id)
    if (!(pipeline.id in jobs)) void loadJobs(pipeline.id)
  }

  const refreshActive = () => {
    if (scope === 'repository') {
      void loadRecent()
    } else {
      void load()
    }
  }

  return (
    <ActionMenu
      label={`${t('shell.pipeline.aria')} · ${stateLabel}`}
      triggerClassName={styles.trigger}
      menuClassName={styles.panel}
      closeOnAction={false}
      onOpen={() => {
        void load()
        if (scope === 'repository') void loadRecent()
      }}
      triggerContent={
        <>
          <span className={styles.icon} data-state={state}>
            <ToolbarIcon name="pipeline" />
          </span>
          <span className={styles.label}>{stateLabel}</span>
          {pipelines.length > 1 ? (
            <span className={styles.count}>
              {settled}/{pipelines.length}
            </span>
          ) : null}
        </>
      }
    >
      <div className={styles.head}>
        <h2 className={styles.title}>{t('shell.pipeline.aria')}</h2>
        <span className={styles.provider}>{provider}</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.ghost}
          disabled={busyRefresh}
          onClick={refreshActive}
        >
          {busyRefresh ? t('shell.pipeline.refreshing') : t('shell.pipeline.refresh')}
        </button>
      </div>
      <div className={styles.tabs} role="tablist" aria-label={t('shell.pipeline.aria')}>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'commit'}
          className={styles.tab}
          data-active={scope === 'commit' || undefined}
          onClick={() => setScope('commit')}
        >
          {t('shell.pipeline.tab.commit')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'repository'}
          className={styles.tab}
          data-active={scope === 'repository' || undefined}
          onClick={() => setScope('repository')}
        >
          {t('shell.pipeline.tab.repository')}
        </button>
      </div>
      {scope === 'commit' ? (
        <>
          <div className={styles.meta}>
            <span className={styles.mono}>
              {overview.branch ?? t('shell.pipeline.detached')}
            </span>
            {overview.sha ? <span className={styles.mono}>{overview.sha.slice(0, 10)}</span> : null}
            <span className={styles.project}>{overview.projectPath || overview.projectName}</span>
          </div>
          <PipelineEntries
            pipelines={pipelines}
            empty={t('shell.pipeline.none')}
            showRef={false}
            expanded={expanded}
            jobs={jobs}
            jobsBusy={jobsBusy}
            onToggle={toggle}
          />
        </>
      ) : (
        <>
          <div className={styles.meta}>
            <span className={styles.project}>
              {overview.projectPath || overview.projectName}
            </span>
            <span>{t('shell.pipeline.allRefs')}</span>
          </div>
          <PipelineEntries
            pipelines={recent ?? []}
            empty={recent === null ? t('shell.pipeline.refreshing') : t('shell.pipeline.noRecent')}
            showRef
            expanded={expanded}
            jobs={jobs}
            jobsBusy={jobsBusy}
            onToggle={toggle}
          />
        </>
      )}
      {error ? (
        <p className={styles.error} role="status">
          {t('shell.pipeline.loadError')} {error}
        </p>
      ) : null}
      <div className={styles.footer}>
        {openTarget ? (
          <button type="button" className={styles.ghost} onClick={() => void openExternalUrl(openTarget)}>
            {t('shell.pipeline.open', { provider })}
          </button>
        ) : null}
      </div>
    </ActionMenu>
  )
}
