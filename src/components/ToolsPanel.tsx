import { useEffect, useState } from 'react'
import { toolConfigure, toolOpen, toolsDetect } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { ToolDescriptor, ToolKind, ToolsReport } from '../types/git'
import shared from './p1.module.css'

type Props = {
  repoId: string
}

const KINDS: Array<{ kind: ToolKind; label: string }> = [
  { kind: 'editor', label: 'Éditeur' },
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'diff', label: 'Diff' },
  { kind: 'merge', label: 'Merge' },
]

export function ToolsPanel({ repoId }: Props) {
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
      setNotice(`${result.label} configuré sur ${result.program}.`)
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
      setNotice(`${kind} lancé.`)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const lists: Array<[string, ToolDescriptor[]]> = report
    ? [
        ['Éditeurs détectés', report.editors],
        ['Terminaux détectés', report.terminals],
        ['Outils de diff détectés', report.diffTools],
        ['Outils de merge détectés', report.mergeTools],
      ]
    : []

  return (
    <div className={shared.root}>
      <div className={shared.columns}>
        <section className={shared.card}>
          <h2>Ouvrir un outil</h2>
          <div className={shared.row}>
            <label className={shared.field}>
              Type d’outil
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ToolKind)}
                aria-label="Type d'outil"
              >
                {KINDS.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              Chemin (optionnel)
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="chemin dans le dépôt (éditeur/diff/merge)"
                aria-label="Chemin"
              />
            </label>
            <button type="button" className={shared.primary} onClick={() => void open()}>
              Ouvrir
            </button>
          </div>
          <p className={shared.notice}>
            Le terminal s'ouvre dans le worktree. L'éditeur s'ouvre sur le fichier
            ou le dépôt. Un outil absent produit une erreur explicite ; aucune
            commande shell arbitraire n'est exécutée.
          </p>
          {notice ? <p className={shared.notice}>{notice}</p> : null}
          {error ? (
            <p className={shared.danger} role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <section className={shared.card}>
          <h2>Configurer un outil</h2>
          <div className={shared.row}>
            <label className={shared.field}>
              Type d’outil
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ToolKind)}
                aria-label="Type à configurer"
              >
                {KINDS.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              Programme
              <input
                value={program}
                onChange={(event) => setProgram(event.target.value)}
                placeholder="programme (ex. meld)"
                aria-label="Programme"
              />
            </label>
          </div>
          <div className={shared.row}>
            <label className={shared.field} style={{ flex: 1 }}>
              Arguments
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="{path} ou {left} {right} ou {ours} {base} {theirs} --output={output}"
                aria-label="Arguments"
              />
            </label>
            <button
              type="button"
              className={shared.primary}
              disabled={!program.trim()}
              onClick={() => void configure()}
            >
              Enregistrer
            </button>
          </div>
          <p className={shared.notice}>
            Placeholders : <code>{'{path}'}</code>, <code>{'{left}'}</code>,{' '}
            <code>{'{right}'}</code>, <code>{'{base}'}</code>, <code>{'{ours}'}</code>,{' '}
            <code>{'{theirs}'}</code>, <code>{'{output}'}</code>.
          </p>
        </section>
      </div>

      <section className={shared.card}>
        <h2>Détection</h2>
        {report ? (
          <div className={shared.split}>
            {lists.map(([label, list]) => (
              <div key={label}>
                <h3>{label}</h3>
                {list.length === 0 ? (
                  <p className={shared.notice}>Aucun.</p>
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
              <h3>Configurés</h3>
              {report.configured.length === 0 ? (
                <p className={shared.notice}>Aucun.</p>
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
          <p className={shared.notice}>Détection…</p>
        )}
      </section>
    </div>
  )
}
