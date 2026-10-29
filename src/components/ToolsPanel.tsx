import { useEffect, useState } from 'react'
import { toolConfigure, toolOpen, toolsDetect } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n, type MessageKey } from '../i18n'
import type { ToolDescriptor, ToolKind, ToolsReport } from '../types/git'
import shared from './p1.module.css'

type Props = {
  repoId: string
}

const KINDS: Array<{ kind: ToolKind; labelKey: MessageKey }> = [
  { kind: 'editor', labelKey: 'settings.tools.kind.editor' },
  { kind: 'terminal', labelKey: 'settings.tools.kind.terminal' },
  { kind: 'diff', labelKey: 'settings.tools.kind.diff' },
  { kind: 'merge', labelKey: 'settings.tools.kind.merge' },
]

export function ToolsPanel({ repoId }: Props) {
  const { t } = useI18n()
  const [report, setReport] = useState<ToolsReport | null>(null)
  const [kind, setKind] = useState<ToolKind>('editor')
  const [program, setProgram] = useState('')
  const [args, setArgs] = useState('{path}')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = () => {
    void toolsDetect()
      .then(setReport)
      .catch((cause: unknown) => setError(errorMessage(cause)))
  }

  useEffect(load, [])

  const configure = async () => {
    setError(null)
    setNotice(null)
    try {
      const result = await toolConfigure({
        kind,
        program: program.trim(),
        args: args.split(/\s+/).filter(Boolean),
      })
      setNotice(t('settings.tools.configuredNotice', { label: result.label, program: result.program }))
      setProgram('')
      load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const open = async () => {
    setError(null)
    setNotice(null)
    try {
      await toolOpen({
        repoId,
        kind,
        path: path.trim() || undefined,
      })
      setNotice(t('settings.tools.launched', { kind: t(KINDS.find((entry) => entry.kind === kind)!.labelKey) }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const lists: Array<[MessageKey, ToolDescriptor[]]> = report
    ? [
        ['settings.tools.detected.editors', report.editors],
        ['settings.tools.detected.terminals', report.terminals],
        ['settings.tools.detected.diffTools', report.diffTools],
        ['settings.tools.detected.mergeTools', report.mergeTools],
      ]
    : []

  return (
    <div className={shared.root}>
      <div className={shared.columns}>
        <section className={shared.card}>
          <h2>{t('settings.tools.openTitle')}</h2>
          <div className={shared.row}>
            <label className={shared.field}>
              {t('settings.tools.kindLabel')}
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ToolKind)}
                aria-label={t('settings.tools.kindAria')}
              >
                {KINDS.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {t(entry.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              {t('settings.tools.pathLabel')}
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t('settings.tools.pathPlaceholder')}
                aria-label={t('settings.tools.pathAria')}
              />
            </label>
            <button type="button" className={shared.primary} onClick={() => void open()}>
              {t('common.open')}
            </button>
          </div>
          <p className={shared.notice}>
            {t('settings.tools.openNotice')}
          </p>
          {notice ? <p className={shared.notice}>{notice}</p> : null}
          {error ? (
            <p className={shared.danger} role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <section className={shared.card}>
          <h2>{t('settings.tools.configureTitle')}</h2>
          <div className={shared.row}>
            <label className={shared.field}>
              {t('settings.tools.kindLabel')}
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ToolKind)}
                aria-label={t('settings.tools.configureKindAria')}
              >
                {KINDS.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {t(entry.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              {t('settings.tools.programLabel')}
              <input
                value={program}
                onChange={(event) => setProgram(event.target.value)}
                placeholder={t('settings.tools.programPlaceholder')}
                aria-label={t('settings.tools.programAria')}
              />
            </label>
          </div>
          <div className={shared.row}>
            <label className={shared.field} style={{ flex: 1 }}>
              {t('settings.tools.argsLabel')}
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder={t('settings.tools.argsPlaceholder')}
                aria-label={t('settings.tools.argsAria')}
              />
            </label>
            <button
              type="button"
              className={shared.primary}
              disabled={!program.trim()}
              onClick={() => void configure()}
            >
              {t('common.save')}
            </button>
          </div>
          <p className={shared.notice}>
            {t('settings.tools.placeholders')} <code>{'{path}'}</code>, <code>{'{left}'}</code>,{' '}
            <code>{'{right}'}</code>, <code>{'{base}'}</code>, <code>{'{ours}'}</code>,{' '}
            <code>{'{theirs}'}</code>, <code>{'{output}'}</code>.
          </p>
        </section>
      </div>

      <section className={shared.card}>
        <h2>{t('settings.tools.detectionTitle')}</h2>
        {report ? (
          <div className={shared.split}>
            {lists.map(([label, list]) => (
              <div key={label}>
                <h3>{t(label)}</h3>
                {list.length === 0 ? (
                  <p className={shared.notice}>{t('settings.tools.none')}</p>
                ) : (
                  <div className={shared.stack}>
                    {list.map((tool) => (
                      <span key={tool.id} className={shared.mono}>
                        {tool.label} · {tool.program} · {tool.args.join(' ')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div>
              <h3>{t('settings.tools.configured')}</h3>
              {report.configured.length === 0 ? (
                <p className={shared.notice}>{t('settings.tools.none')}</p>
              ) : (
                <div className={shared.stack}>
                  {report.configured.map((tool) => (
                    <span key={tool.id} className={shared.mono}>
                      {tool.kind} · {tool.program} · {tool.args.join(' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className={shared.notice}>{t('settings.tools.detecting')}</p>
        )}
      </section>
    </div>
  )
}
