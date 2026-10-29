import { useCallback, useEffect, useState } from 'react'
import {
  formatNumber,
  useI18n,
  type MessageKey,
  type TranslationParams,
} from '../i18n'
import {
  submoduleAdd,
  submoduleList,
  submoduleSync,
  submoduleUpdate,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { SubmoduleReport, SubmoduleState } from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

type Translate = (key: MessageKey, params?: TranslationParams) => string

function stateLabel(state: SubmoduleState, t: Translate): {
  text: string
  tone: string
  className: string
} {
  switch (state) {
    case 'upToDate':
      return {
        text: t('ops.submodule.state.upToDate'),
        tone: 'good',
        className: p2.chipGood,
      }
    case 'modified':
      return {
        text: t('ops.submodule.state.modified'),
        tone: 'warn',
        className: p2.chipWarn,
      }
    case 'notInitialized':
      return {
        text: t('ops.submodule.state.notInitialized'),
        tone: '',
        className: '',
      }
    case 'conflict':
      return {
        text: t('ops.submodule.state.conflict'),
        tone: 'bad',
        className: p2.chipBad,
      }
  }
}

export function SubmodulesPanel({ repoId, generation, onMutated }: Props) {
  const { t } = useI18n()
  const [report, setReport] = useState<SubmoduleReport | null>(null)
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [remote, setRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setReport(await submoduleList(repoId))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, generation])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const entries = report?.entries ?? []

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <span className={`${p2.count} ${p2.tabnum}`}>
          {t('ops.submodule.count', { count: formatNumber(entries.length) })}
        </span>
        <span className={p2.spacer} />
        <label className={p2.checkbox}>
          <input
            type="checkbox"
            checked={recursive}
            onChange={(event) => setRecursive(event.target.checked)}
          />
          {t('ops.submodule.recursive')}
        </label>
        <label className={p2.checkbox}>
          <input
            type="checkbox"
            checked={remote}
            onChange={(event) => setRemote(event.target.checked)}
          />
          {t('ops.submodule.followRemote')}
        </label>
        <button
          type="button"
          className={p2.secondary}
          disabled={busy}
          onClick={() =>
            void run(t('ops.submodule.notice.updated'), () =>
              submoduleUpdate({ repoId, init: true, recursive, remote }),
            )
          }
        >
          {t('ops.submodule.initUpdate')}
        </button>
        <button
          type="button"
          className={p2.ghost}
          disabled={busy}
          onClick={() =>
            void run(t('ops.submodule.notice.synced'), () =>
              submoduleSync({ repoId, recursive }),
            )
          }
        >
          {t('ops.submodule.sync')}
        </button>
      </div>

      <p className={p2.hintBar}>{t('ops.submodule.hint')}</p>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className={p2.listHeader} role="status">
          <span className={p2.meta}>{notice}</span>
        </div>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          <div className={p2.listHeader}>
            <span className={p2.label}>{t('ops.submodule.pointers')}</span>
            <span className={p2.spacer} />
            {report?.truncated ? (
              <span className={`${p2.chip} ${p2.chipWarn}`}>
                {t('ops.submodule.capped')}
              </span>
            ) : null}
          </div>

          <div className={p2.rows}>
            {entries.map((entry) => {
              const label = stateLabel(entry.state, t)
              return (
                <div key={entry.path} className={p2.entry}>
                  <span className={p2.dot} data-tone={label.tone || undefined} />
                  <div className={p2.entryStack}>
                    <span className={`${p2.entryTitle} ${p2.mono}`}>{entry.path}</span>
                    <span className={p2.entryMeta}>
                      <span className={`${p2.chip} ${label.className}`}>{label.text}</span>
                      <span className={p2.mono}>{entry.sha.slice(0, 10)}</span>
                      <span>·</span>
                      <span>
                        {entry.describe ??
                          (entry.nested
                            ? t('ops.submodule.nested')
                            : t('ops.submodule.noDescription'))}
                      </span>
                    </span>
                  </div>
                  <span className={p2.entryActions}>
                    <button
                      type="button"
                      className={p2.secondary}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          t('ops.submodule.notice.pointerUpdated', {
                            path: entry.path,
                          }),
                          () =>
                            submoduleUpdate({
                              repoId,
                              path: entry.path,
                              init: true,
                              recursive: false,
                              remote,
                            }),
                        )
                      }
                    >
                      {t('ops.submodule.update')}
                    </button>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          t('ops.submodule.notice.syncedFor', { path: entry.path }),
                          () =>
                            submoduleSync({
                              repoId,
                              path: entry.path,
                              recursive: false,
                            }),
                        )
                      }
                    >
                      {t('ops.submodule.sync')}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>

          {report && entries.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('ops.submodule.emptyTitle')}</h2>
              <p>{t('ops.submodule.emptyBody')}</p>
            </div>
          ) : null}
        </div>

        <aside className={p2.screenAside}>
          <section className={p2.asideSection}>
            <h2 className={p2.asideTitle}>{t('ops.submodule.addTitle')}</h2>
            <label className={p2.field}>
              URL
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://gitlab.example.com/team/sdk.git"
                spellCheck={false}
              />
            </label>
            <label className={p2.field}>
              {t('common.path')}
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="vendor/sdk"
                spellCheck={false}
              />
            </label>
            <label className={p2.field}>
              Branche suivie (optionnel)
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className={p2.primary}
              disabled={busy || !url.trim() || !path.trim()}
              onClick={() =>
                void run(t('ops.submodule.notice.added'), async () => {
                  await submoduleAdd({
                    repoId,
                    url: url.trim(),
                    path: path.trim(),
                    branch: branch.trim() || undefined,
                  })
                  setUrl('')
                  setPath('')
                  setBranch('')
                })
              }
            >
              {t('ops.submodule.addLabel')}
            </button>
            <p className={p2.asideHint}>
              {t('ops.submodule.addHint')}
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}
