import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { MessageKey } from '../i18n/translate'
import { errorMessage } from '../ipc/client'
import { openExternalUrl, pipelineJobs, pipelineOverview } from '../ipc/commands'
import { aggregatePipelineState, isSettled, pipelineState } from '../lib/pipeline'
import type { GitlabPipeline, PipelineJob, PipelineOverview, PipelineState } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './PipelineStatus.module.css'

/** Slow enough to stay polite with the forge, fast enough to follow a run. */
const REFRESH_MS = 30_000

const STATE_KEYS: Record<PipelineState, MessageKey> = {
  pending: 'shell.pipeline.state.pending',
  running: 'shell.pipeline.state.running',
  success: 'shell.pipeline.state.success',
  failed: 'shell.pipeline.state.failed',
  canceled: 'shell.pipeline.state.canceled',
  neutral: 'shell.pipeline.state.neutral',
  unknown: 'shell.pipeline.state.unknown',
}

type Props = {
  repoId: string | null
  /** Repository generation: any state change reloads the commit pipelines. */
  generation: number
}

/**
 * CI state of the commit checked out in the active repository.
 *
 * Renders nothing until a forge project is linked and connected: the
 * indicator is repo-scoped chrome, not a session-wide status.
 */
export function PipelineStatus({ repoId, generation }: Props) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<PipelineOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [jobs, setJobs] = useState<Record<number, PipelineJob[]>>({})
  const [jobsBusy, setJobsBusy] = useState(false)
  const request = useRef(0)

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
    if (!repoId) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [repoId, load])

  // A poll may have changed the run behind the open panel: refresh its jobs.
  useEffect(() => {
    if (expanded !== null) void loadJobs(expanded)
  }, [expanded, overview, loadJobs])

  if (!overview) return null

  const pipelines = overview.pipelines
  const state = aggregatePipelineState(pipelines.map((pipeline) => pipeline.status))
  const settled = pipelines.filter((pipeline) => isSettled(pipelineState(pipeline.status))).length
  const provider = overview.provider === 'github' ? 'GitHub' : 'GitLab'
  const stateLabel = t(STATE_KEYS[state])
  const openTarget = pipelines[0]?.webUrl ?? overview.projectWebUrl

  const toggle = (pipeline: GitlabPipeline) => {
    if (expanded === pipeline.id) {
      setExpanded(null)
      return
    }
    setExpanded(pipeline.id)
    if (!(pipeline.id in jobs)) void loadJobs(pipeline.id)
  }

  return (
    <ActionMenu
      label={`${t('shell.pipeline.aria')} · ${stateLabel}`}
      triggerClassName={styles.trigger}
      menuClassName={styles.panel}
      closeOnAction={false}
      onOpen={() => void load()}
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
          disabled={refreshing}
          onClick={() => void load()}
        >
          {refreshing ? t('shell.pipeline.refreshing') : t('shell.pipeline.refresh')}
        </button>
      </div>
      <div className={styles.meta}>
        <span className={styles.mono}>
          {overview.branch ?? t('shell.pipeline.detached')}
        </span>
        {overview.sha ? <span className={styles.mono}>{overview.sha.slice(0, 10)}</span> : null}
        <span className={styles.project}>{overview.projectPath || overview.projectName}</span>
      </div>
      {pipelines.length === 0 ? (
        <p className={styles.hint}>{t('shell.pipeline.none')}</p>
      ) : (
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
                    onClick={() => toggle(pipeline)}
                  >
                    <span className={styles.dot} data-state={itemState} />
                    <span className={styles.entryName}>
                      {pipeline.detailedStatus ?? `#${pipeline.id}`}
                    </span>
                    <span className={styles.entryState}>{t(STATE_KEYS[itemState])}</span>
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
                              <span className={styles.entryState}>{t(STATE_KEYS[jobState])}</span>
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
