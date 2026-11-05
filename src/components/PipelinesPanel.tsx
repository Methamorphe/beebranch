import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDateTime, formatRelative, useI18n } from '../i18n'
import { errorMessage } from '../ipc/client'
import {
  githubJobLog,
  gitlabJobLog,
  openExternalUrl,
  pipelineHistory,
  pipelineJobs,
} from '../ipc/commands'
import {
  aggregatePipelineState,
  PIPELINE_STATE_KEYS,
  pipelineRefLabel,
  pipelineState,
} from '../lib/pipeline'
import type {
  GitlabPipeline,
  JobLog,
  PipelineHistory,
  PipelineJob,
} from '../types/git'
import { Dialog } from './ui/Dialog'
import p2 from './p2.module.css'
import styles from './PipelinesPanel.module.css'

/** Slow enough to stay polite with the forge, fast enough to follow a run. */
const REFRESH_MS = 30_000

/** "3 hours ago" within the week, the absolute date beyond it. */
function ageLabel(updatedAt: string | undefined): string | null {
  if (!updatedAt) return null
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return null
  return (
    formatRelative(date) ??
    formatDateTime(date, { dateStyle: 'short', timeStyle: 'short' })
  )
}

/** Jobs grouped by stage, in the order the forge reports the stages. */
function stagesOf(jobs: PipelineJob[]): { stage: string; items: PipelineJob[] }[] {
  const groups: { stage: string; items: PipelineJob[] }[] = []
  for (const job of jobs) {
    const existing = groups.find((group) => group.stage === job.stage)
    if (existing) {
      existing.items.push(job)
    } else {
      groups.push({ stage: job.stage, items: [job] })
    }
  }
  return groups
}

type Context = {
  provider: string
  projectId: number
  projectPath: string
}

type Props = {
  repoId: string | null
  /** Repository generation: any state change reloads the history. */
  generation: number
}

/**
 * Pipelines of the linked project across every ref, with the stages and jobs
 * of the one the user opens, and the log of any job in place. Meant for the
 * repository navigator: the list stays compact and the detail replaces it, so
 * a narrow column remains readable.
 */
export function PipelinesPanel({ repoId, generation }: Props) {
  const { t } = useI18n()
  const [context, setContext] = useState<Context | null>(null)
  const [items, setItems] = useState<GitlabPipeline[]>([])
  const [nextPage, setNextPage] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GitlabPipeline | null>(null)
  const [jobs, setJobs] = useState<PipelineJob[] | null>(null)
  const [jobsBusy, setJobsBusy] = useState(false)
  const [log, setLog] = useState<{ job: PipelineJob; value: JobLog } | null>(null)
  const [logBusy, setLogBusy] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  /** More than the first page is loaded: polling must not collapse it. */
  const [paged, setPaged] = useState(false)
  const request = useRef(0)

  const loadPage = useCallback(
    async (page: number, append: boolean) => {
      if (!repoId) return
      const id = ++request.current
      setLoading(true)
      setError(null)
      try {
        const pageData: PipelineHistory = await pipelineHistory(repoId, page)
        if (id !== request.current) return
        setItems((current) => (append ? [...current, ...pageData.items] : pageData.items))
        setNextPage(pageData.nextPage)
        if (!append) {
          setContext(
            pageData.projectId
              ? {
                  provider: pageData.provider,
                  projectId: pageData.projectId,
                  projectPath: pageData.projectPath,
                }
              : null,
          )
        }
      } catch (cause) {
        if (id !== request.current) return
        setError(errorMessage(cause))
      } finally {
        if (id === request.current) setLoading(false)
      }
    },
    [repoId],
  )

  const loadJobs = useCallback(
    async (pipelineId: number) => {
      if (!repoId) return
      setJobsBusy(true)
      try {
        const page = await pipelineJobs(repoId, pipelineId)
        setJobs(page)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setJobsBusy(false)
      }
    },
    [repoId],
  )

  const loadLog = useCallback(
    async (job: PipelineJob, offset?: number) => {
      if (!context || !context.projectId) return
      setLogBusy(true)
      setLogError(null)
      try {
        const request = {
          projectId: context.projectId,
          jobId: job.id,
          ...(offset !== undefined ? { offset } : {}),
        }
        const value =
          context.provider === 'github'
            ? await githubJobLog(request)
            : await gitlabJobLog(request)
        setLog((current) =>
          offset !== undefined && current
            ? { job, value: { ...value, text: `${current.value.text}\n${value.text}` } }
            : { job, value },
        )
      } catch (cause) {
        setLogError(errorMessage(cause))
      } finally {
        setLogBusy(false)
      }
    },
    [context],
  )

  useEffect(() => {
    setItems([])
    setNextPage(undefined)
    setContext(null)
    setSelected(null)
    setJobs(null)
    setLog(null)
    setError(null)
    setPaged(false)
    void loadPage(1, false)
  }, [loadPage, generation])

  useEffect(() => {
    if (selected === null) {
      setJobs(null)
      return
    }
    void loadJobs(selected.id)
  }, [selected, loadJobs])

  useEffect(() => {
    if (!repoId) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      if (selected !== null) {
        void loadJobs(selected.id)
      } else if (!paged) {
        void loadPage(1, false)
      }
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [repoId, loadPage, loadJobs, selected, paged])

  if (!repoId) return null

  const refresh = () => {
    if (selected !== null) {
      void loadJobs(selected.id)
      return
    }
    setPaged(false)
    void loadPage(1, false)
  }

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        {selected ? (
          <button type="button" className={styles.back} onClick={() => setSelected(null)}>
            ‹ {t('shell.pipeline.history.back')}
          </button>
        ) : (
          <span className={styles.caption}>{t('shell.pipeline.history.caption')}</span>
        )}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.ghost}
          disabled={loading || jobsBusy}
          onClick={refresh}
        >
          {loading || jobsBusy ? t('shell.pipeline.refreshing') : t('shell.pipeline.refresh')}
        </button>
      </div>

      {selected ? (
        <PipelineDetail
          pipeline={selected}
          jobs={jobs}
          jobsBusy={jobsBusy}
          onOpen={() => {
            if (selected.webUrl) void openExternalUrl(selected.webUrl)
          }}
          onJob={(job) => void loadLog(job)}
        />
      ) : (
        <>
          {items.length === 0 && !loading ? (
            <p className={styles.hint}>{t('shell.pipeline.history.empty')}</p>
          ) : (
            <ul className={styles.list}>
              {items.map((pipeline) => {
                const state = pipelineState(pipeline.status)
                return (
                  <li key={pipeline.id}>
                    <button
                      type="button"
                      className={styles.row}
                      data-pipeline={pipeline.id}
                      onClick={() => setSelected(pipeline)}
                    >
                      <span className={styles.dot} data-state={state} />
                      <span className={styles.id}>#{pipeline.id}</span>
                      <span className={styles.ref} title={pipeline.refName ?? undefined}>
                        {pipelineRefLabel(pipeline.refName) ?? t('shell.pipeline.detached')}
                      </span>
                      <span className={styles.age}>{ageLabel(pipeline.updatedAt) ?? ''}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {nextPage !== undefined ? (
            <button
              type="button"
              className={styles.more}
              disabled={loading}
              onClick={() => {
                setPaged(true)
                void loadPage(nextPage, true)
              }}
            >
              {t('shell.pipeline.history.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {error ? (
        <p className={styles.error} role="status">
          {t('shell.pipeline.loadError')} {error}
        </p>
      ) : null}

      <Dialog
        open={log !== null}
        onClose={() => setLog(null)}
        busy={logBusy}
        titleId="pipeline-job-log-title"
        className={styles.logDialog}
      >
        {log ? (
          <section className={styles.logSection}>
            <div className={p2.row}>
              <h2 id="pipeline-job-log-title" className={styles.logTitle}>
                {log.job.stage} / {log.job.name}
              </h2>
              <span className={p2.spacer} />
              {log.job.webUrl ? (
                <button
                  type="button"
                  className={p2.ghost}
                  onClick={() => void openExternalUrl(log.job.webUrl!)}
                >
                  {t('common.open')}
                </button>
              ) : null}
              <button type="button" className={p2.ghost} onClick={() => setLog(null)}>
                {t('common.close')}
              </button>
            </div>
            <p className={p2.asideHint}>
              {t('shell.pipeline.log.summary', {
                size: t('common.bytes', { count: log.value.bytes }),
              })}
              {log.value.truncated ? ` ${t('shell.pipeline.log.truncated')}` : ''}
            </p>
            <pre className={`${p2.log} ${styles.logPre}`}>{log.value.text}</pre>
            {log.value.nextOffset !== undefined ? (
              <button
                type="button"
                className={p2.secondary}
                disabled={logBusy}
                onClick={() => void loadLog(log.job, log.value.nextOffset)}
              >
                {t('shell.pipeline.log.more')}
              </button>
            ) : null}
            {logError ? (
              <p className={styles.error} role="status">
                {t('shell.pipeline.log.unavailable')} {logError}
              </p>
            ) : null}
          </section>
        ) : null}
      </Dialog>
    </div>
  )
}

type DetailProps = {
  pipeline: GitlabPipeline
  jobs: PipelineJob[] | null
  jobsBusy: boolean
  onOpen: () => void
  onJob: (job: PipelineJob) => void
}

function PipelineDetail({ pipeline, jobs, jobsBusy, onOpen, onJob }: DetailProps) {
  const { t } = useI18n()
  const state = pipelineState(pipeline.status)
  const age = ageLabel(pipeline.updatedAt)
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={styles.dot} data-state={state} />
        <strong className={styles.id}>#{pipeline.id}</strong>
        <span className={styles.entryState}>{t(PIPELINE_STATE_KEYS[state])}</span>
        <span className={styles.spacer} />
        {pipeline.webUrl ? (
          <button type="button" className={styles.ghost} onClick={onOpen}>
            {t('common.open')}
          </button>
        ) : null}
      </div>
      <div className={styles.meta}>
        <span className={styles.ref} title={pipeline.refName ?? undefined}>
          {pipelineRefLabel(pipeline.refName) ?? t('shell.pipeline.detached')}
        </span>
        {pipeline.sha ? <span className={styles.mono}>{pipeline.sha.slice(0, 10)}</span> : null}
        {pipeline.detailedStatus ? (
          <span className={styles.muted}>{pipeline.detailedStatus}</span>
        ) : null}
        {age ? <span className={styles.muted}>{age}</span> : null}
      </div>
      {jobsBusy && !jobs ? (
        <p className={styles.hint}>{t('shell.pipeline.refreshing')}</p>
      ) : jobs && jobs.length > 0 ? (
        stagesOf(jobs).map((group) => {
          const stageState = aggregatePipelineState(group.items.map((job) => job.status))
          return (
            <div key={group.stage} className={styles.stage}>
              <div className={styles.stageHead}>
                <span className={styles.dot} data-state={stageState} />
                <span className={styles.stageName}>{group.stage}</span>
                <span className={styles.stageState}>{t(PIPELINE_STATE_KEYS[stageState])}</span>
              </div>
              <ul className={styles.jobList}>
                {group.items.map((job) => {
                  const jobState = pipelineState(job.status)
                  return (
                    <li key={job.id}>
                      <button
                        type="button"
                        className={styles.job}
                        title={t('shell.pipeline.log.open')}
                        onClick={() => onJob(job)}
                      >
                        <span className={styles.dot} data-state={jobState} />
                        <span className={styles.jobName}>{job.name}</span>
                        <span className={styles.entryState}>
                          {t(PIPELINE_STATE_KEYS[jobState])}
                        </span>
                        {job.duration !== undefined ? (
                          <span className={styles.mono}>{Math.round(job.duration)} s</span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })
      ) : (
        <p className={styles.hint}>{t('shell.pipeline.noJobs')}</p>
      )}
    </div>
  )
}
