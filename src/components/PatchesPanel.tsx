import { useState } from 'react'
import { formatNumber, useI18n, type MessageKey } from '../i18n'
import { patchApply, patchCreate, patchSave } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { PatchReport, PatchSource } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  onMutated: () => void
}

type Kind = 'worktree' | 'index' | 'commit' | 'range'

const KINDS: { value: Kind; labelKey: MessageKey }[] = [
  { value: 'worktree', labelKey: 'ops.patch.kind.worktree' },
  { value: 'index', labelKey: 'ops.patch.kind.index' },
  { value: 'commit', labelKey: 'ops.patch.kind.commit' },
  { value: 'range', labelKey: 'ops.patch.kind.range' },
]

export function PatchesPanel({ repoId, onMutated }: Props) {
  const { t } = useI18n()
  const [kind, setKind] = useState<Kind>('worktree')
  const [pathFilter, setPathFilter] = useState('')
  const [commit, setCommit] = useState('HEAD')
  const [base, setBase] = useState('HEAD~1')
  const [target, setTarget] = useState('HEAD')
  const [report, setReport] = useState<PatchReport | null>(null)
  const [text, setText] = useState('')
  const [threeWay, setThreeWay] = useState(false)
  const [stage, setStage] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [applyOpen, setApplyOpen] = useState(false)

  const paths = pathFilter
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const source: PatchSource =
    kind === 'worktree'
      ? { kind: 'worktree', paths }
      : kind === 'index'
        ? { kind: 'index', paths }
        : kind === 'commit'
          ? { kind: 'commit', sha: commit.trim(), paths }
          : { kind: 'range', base: base.trim(), target: target.trim(), paths }

  const create = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await patchCreate({ repoId, source })
      setReport(result)
      setText(result.text)
      setNotice(t('ops.patch.notice.created', { source: result.source }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await patchApply({
        repoId,
        text,
        threeWay,
        stage,
      })
      setNotice(
        result.data.staged
          ? t('ops.patch.notice.appliedStaged', {
              count: formatNumber(result.data.files.length),
            })
          : t('ops.patch.notice.applied', {
              count: formatNumber(result.data.files.length),
            }),
      )
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <div className={p2.segmented} role="group" aria-label={t('ops.patch.provenanceAria')}>
          {KINDS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={kind === item.value ? p2.segmentOn : p2.segment}
              aria-pressed={kind === item.value}
              onClick={() => setKind(item.value)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        {kind === 'commit' ? (
          <label className={p2.fieldInline}>
            <span className={p2.toolbarLabel}>{t('common.commit')}</span>
            <input
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              spellCheck={false}
            />
          </label>
        ) : null}
        {kind === 'range' ? (
          <>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('ops.patch.baseLabel')}</span>
              <input
                value={base}
                onChange={(event) => setBase(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('ops.patch.targetLabel')}</span>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                spellCheck={false}
              />
            </label>
          </>
        ) : null}

        <label className={`${p2.fieldInline} ${p2.grow}`}>
          <span className={p2.toolbarLabel}>{t('ops.patch.pathsLabel')}</span>
          <input
            value={pathFilter}
            onChange={(event) => setPathFilter(event.target.value)}
            placeholder="src/app.ts, docs/"
            spellCheck={false}
          />
        </label>

        <button
          type="button"
          className={p2.primary}
          disabled={busy}
          onClick={() => void create()}
        >
          {t('ops.patch.generate')}
        </button>
      </div>

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
        <div className={p2.screenMain} data-fill="true">
          <div className={p2.listHeader}>
            <span className={p2.label}>{t('ops.patch.provenance')}</span>
            <span className={p2.meta}>{report?.source ?? t('ops.patch.noPatch')}</span>
            {report ? (
              <>
                <span className={p2.count}>·</span>
                <span className={`${p2.count} ${p2.tabnum}`}>
                  {t('common.bytes', { count: formatNumber(report.bytes) })}
                </span>
                <span className={p2.count}>·</span>
                <span className={`${p2.count} ${p2.tabnum}`}>
                  {t('ops.patch.fileCount', {
                    count: formatNumber(report.files.length),
                  })}
                </span>
              </>
            ) : null}
            <span className={p2.spacer} />
            {report?.truncated ? (
              <span className={`${p2.chip} ${p2.chipWarn}`}>
                {t('ops.patch.truncated')}
              </span>
            ) : null}
          </div>

          <textarea
            className={`${p2.editor} ${p2.editorFill}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('ops.patch.contentPlaceholder')}
            spellCheck={false}
            aria-label={t('ops.patch.contentAria')}
          />

          <div className={p2.footerBar}>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={threeWay}
                onChange={(event) => setThreeWay(event.target.checked)}
              />
              {t('ops.patch.threeWay')}
            </label>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={stage}
                onChange={(event) => setStage(event.target.checked)}
              />
              {t('ops.patch.applyToIndex')}
            </label>
            <span className={p2.spacer} />
            <button
              type="button"
              className={p2.primary}
              disabled={busy || !text.trim()}
              onClick={() => setApplyOpen(true)}
            >
              {t('ops.patch.verifyApply')}
            </button>
          </div>
        </div>

        <aside className={p2.screenAside}>
          <section className={p2.asideSection}>
            <h2 className={p2.asideTitle}>{t('ops.patch.exportTitle')}</h2>
            <label className={p2.field}>
              {t('ops.patch.exportPathLabel')}
              <input
                value={exportPath}
                onChange={(event) => setExportPath(event.target.value)}
                placeholder="/Users/you/patches/fix.patch"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className={p2.secondary}
              disabled={busy || !report || !exportPath.trim()}
              onClick={() => {
                setBusy(true)
                setError(null)
                void patchSave(exportPath.trim(), text)
                  .then((saved) =>
                    setNotice(t('ops.patch.notice.exported', { path: saved })),
                  )
                  .catch((cause) => setError(errorMessage(cause)))
                  .finally(() => setBusy(false))
              }}
            >
              {t('ops.patch.exportTitle')}
            </button>
            <p className={p2.asideHint}>{t('ops.patch.exportHint')}</p>
          </section>

          {report ? (
            <section className={p2.asideSection}>
              <h2 className={p2.asideTitle}>
                {t('common.files')}{' '}
                <span className={p2.count}>{formatNumber(report.files.length)}</span>
              </h2>
              <div className={p2.rows}>
                {report.files.map((file) => (
                  <div key={file} className={p2.entry}>
                    <span className={p2.dot} data-tone="info" />
                    <span className={`${p2.entryTitle} ${p2.mono}`}>{file}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={applyOpen}
        title={t('ops.patch.applyTitle')}
        consequence={t('ops.patch.applyConsequence', {
          source: report?.source
            ? t('ops.patch.sourceGenerated', { source: report.source })
            : t('ops.patch.sourcePasted'),
          // `--3way` implies `--index`: the change is staged even without the
          // “apply to index” option, so the confirmation says so.
          destination:
            stage || threeWay ? t('ops.patch.destIndex') : t('ops.patch.destWorktree'),
        })}
        confirmLabel={t('common.apply')}
        busy={busy}
        onCancel={() => setApplyOpen(false)}
        onConfirm={() => {
          setApplyOpen(false)
          void apply()
        }}
      />
    </div>
  )
}
