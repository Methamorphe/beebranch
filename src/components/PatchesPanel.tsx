import { useState } from 'react'
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

export function PatchesPanel({ repoId, onMutated }: Props) {
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
      setNotice(`Patch généré depuis ${result.source}.`)
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
        `Patch appliqué : ${result.data.files.length} fichier(s)${
          result.data.staged ? ' (indexé)' : ''
        }.`,
      )
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={p2.pageColumn}>
      <div className={p2.between}>
        <h2 className={p2.cardTitle}>Patches</h2>
        <span className={p2.pill}>Fichiers texte</span>
      </div>
      <p className={p2.notice}>
        Générez un patch depuis le worktree, l’index, un commit ou une plage. La
        provenance est toujours visible avant application.
      </p>

      <div className={p2.tabs} style={{ padding: '8px 0', borderBottom: 0 }}>
        {(['worktree', 'index', 'commit', 'range'] as Kind[]).map((value) => (
          <button
            key={value}
            type="button"
            className={kind === value ? p2.tabOn : p2.tab}
            onClick={() => setKind(value)}
          >
            {value}
          </button>
        ))}
      </div>

      <div className={p2.row} style={{ alignItems: 'flex-end' }}>
        {kind === 'commit' ? (
          <label className={p2.field}>
            Commit
            <input value={commit} onChange={(event) => setCommit(event.target.value)} spellCheck={false} />
          </label>
        ) : null}
        {kind === 'range' ? (
          <>
            <label className={p2.field}>
              Base
              <input value={base} onChange={(event) => setBase(event.target.value)} spellCheck={false} />
            </label>
            <label className={p2.field}>
              Cible
              <input value={target} onChange={(event) => setTarget(event.target.value)} spellCheck={false} />
            </label>
          </>
        ) : null}
        <label className={p2.field} style={{ flex: 1 }}>
          Chemins (séparés par des virgules, optionnel)
          <input
            value={pathFilter}
            onChange={(event) => setPathFilter(event.target.value)}
            placeholder="src/app.ts, docs/"
            spellCheck={false}
          />
        </label>
        <button type="button" className={p2.primary} disabled={busy} onClick={() => void create()}>
          Générer le patch
        </button>
      </div>

      {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
      {notice ? <p className={p2.notice}>{notice}</p> : null}

      <div className={p2.split} style={{ overflow: 'auto', marginTop: 10 }}>
        <div className={p2.splitMain}>
          <div className={p2.between}>
            <span className={p2.small}>
              Provenance : <strong>{report?.source ?? 'aucun patch généré'}</strong>
              {report ? ` · ${report.bytes} octets · ${report.files.length} fichier(s)` : ''}
              {report?.truncated ? ' · tronqué' : ''}
            </span>
            {report ? (
              <span className={p2.row}>
                <button
                  type="button"
                  className={p2.secondary}
                  disabled={busy || !text.trim()}
                  onClick={() => setApplyOpen(true)}
                >
                  Appliquer
                </button>
              </span>
            ) : null}
          </div>
          <textarea
            className={p2.editor}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Collez un patch ici, ou générez-le ci-dessus."
            spellCheck={false}
            style={{ minHeight: 320 }}
            aria-label="Contenu du patch"
          />
          <div className={p2.row}>
            <label className={p2.checkbox}>
              <input type="checkbox" checked={threeWay} onChange={(event) => setThreeWay(event.target.checked)} />
              merge 3-way (dérive de contexte)
            </label>
            <label className={p2.checkbox}>
              <input type="checkbox" checked={stage} onChange={(event) => setStage(event.target.checked)} />
              appliquer à l’index
            </label>
            <span className={p2.spacer} />
            <button
              type="button"
              className={p2.ghost}
              disabled={busy || !text.trim()}
              onClick={() => setApplyOpen(true)}
            >
              Vérifier / appliquer
            </button>
          </div>
        </div>

        <div className={p2.splitSide}>
          <h3 className={p2.cardTitle}>Exporter</h3>
          <label className={p2.field}>
            Chemin absolu du fichier
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
                .then((saved) => setNotice(`Patch exporté vers ${saved}.`))
                .catch((cause) => setError(errorMessage(cause)))
                .finally(() => setBusy(false))
            }}
          >
            Exporter
          </button>
          <p className={p2.notice}>
            L’export n’écrase jamais un fichier existant. Un patch binaire est
            refusé explicitement.
          </p>
          {report ? (
            <div className={p2.card}>
              <strong>Fichiers</strong>
              {report.files.map((file) => (
                <div key={file} className={p2.listSub}>
                  {file}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={applyOpen}
        title="Appliquer un patch"
        consequence={`Le patch ${report?.source ? `généré depuis ${report.source}` : 'collé'} sera vérifié puis appliqué${stage ? ' à l’index' : ' au worktree'}. En cas de conflit, rien n’est écrit.`}
        confirmLabel="Appliquer"
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
