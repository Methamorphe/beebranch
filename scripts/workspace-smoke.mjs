import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runRepositoryWorkspaceSmoke({ client, evaluate, screenshot, waitFor, delay, outDir }) {
  const results = {}
  const check = async (name, expression) => {
    results[name] = Boolean(await evaluate(client, expression))
    if (!results[name]) throw new Error('Repository workspace: ' + name)
  }
  const click = async (selector) => {
    const clicked = await evaluate(client, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element?.click(); return Boolean(element) })()`)
    if (!clicked) throw new Error('Missing action: ' + selector)
    await delay(80)
  }
  const verifyInlineWidth = async (id) => {
    for (const width of [180, 210, 320]) {
      await evaluate(client, `document.querySelector('aside[aria-label="Explorateur du dépôt"]').style.width = '${width}px'`)
      await delay(40)
      const overflow = await evaluate(client, `(() => {
        const tool = document.querySelector('[data-repository-tool="${id}"]')
        const bounds = tool.getBoundingClientRect()
        return Array.from(tool.querySelectorAll('*')).filter((element) => {
          const r = element.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && (r.left < bounds.left - 1 || r.right > bounds.right + 1)
        }).map((element) => ({ tag:element.tagName, cls:element.className, text:element.textContent.slice(0,80) }))
      })()`)
      if (overflow.length) throw new Error('Overflow ' + id + ' at ' + width + ': ' + JSON.stringify(overflow.slice(0,8)))
      await check(id + '-fits-' + width, `document.querySelector('[data-repository-tool="${id}"]').getBoundingClientRect().width <= ${width}`)
      if (id === 'worktrees' && width === 210) {
        await evaluate(client, `document.querySelector('[data-repository-tool="worktrees"] aside').scrollIntoView({ block:'center' })`)
        await screenshot('workspace-worktrees-narrow.png')
      }
    }
    await evaluate(client, `document.querySelector('aside[aria-label="Explorateur du dépôt"]').style.width = ''`)
  }
  await evaluate(client, `(() => {
    window.__workspaceCanvas = document.querySelector('canvas')
    window.__workspaceCalls = []
    window.__workspaceStashes = [{ selector:'stash@{0}', sha:'0000000000000000000000000000000000000001', timestamp:1700000000, message:'WIP on main: saved changes' }]
    const original = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      window.__workspaceCalls.push([command, args])
      if (command === 'stash_list') return window.__workspaceStashes
      if (command === 'branch_checkout') return { data:null, generation:4 }
      if (command === 'stash_apply') return { data:{ applied:true, conflicts:[], output:'' }, generation:4 }
      if (command === 'stash_pop') { window.__workspaceStashes = []; return { data:{ applied:true, conflicts:[], output:'' }, generation:4 } }
      if (command === 'stash_create') {
        window.__workspaceStashes = [{ selector:'stash@{0}', sha:'0000000000000000000000000000000000000001', timestamp:1700000000, message:'WIP on main: new stash' }]
        return { data:'stash@{0}', generation:4 }
      }
      if (command === 'stash_drop') { window.__workspaceStashes = []; return { data:'dropped', generation:4 } }
      const result = await original(command, args)
      if (command === 'diff_get' && window.__workspaceSingleDiff) result.data.files = result.data.files.slice(0, 1)
      if (command === 'repo_refresh') result.generation = window.__workspaceRefresh = (window.__workspaceRefresh ?? 90) + 1
      if (command === 'graph_page' && result.rows?.length) result.rows[0] = { ...result.rows[0], stash:'stash@{0}' }
      return result
    }
    window.__generationOverride = 4
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:4, areas:['state'] })
    return true
  })()`)
  await waitFor(client, `document.querySelector('[data-stash="stash@{0}"]') !== null`, 'stash in repository tree')
  await check('one-repository-explorer', `document.querySelectorAll('aside[aria-label="Explorateur du dépôt"]').length === 1`)
  await check('no-destination-sidebar', `!document.querySelector('aside button[data-view]')`)
  await check('no-extra-branch-panel', `!document.querySelector('#branch-list-panel')`)
  await check('repository-sections', `['local','remotes','tags','stash','worktrees','submodules','mrs','prs','patches','search','operations'].every((id) => document.querySelector('[data-repository-section="' + id + '"]'))`)
  await check('graph-fills-height', `document.querySelector('canvas').getBoundingClientRect().height > 600`)
  await screenshot('workspace-tree.png')
  await evaluate(client, `document.documentElement.dataset.density = 'compact'`)
  await delay(300)
  await screenshot('workspace-graph-compact.png')
  await evaluate(client, `document.documentElement.dataset.density = 'comfortable'`)

  for (const id of ['remotes', 'tags', 'stash', 'worktrees', 'submodules', 'mrs', 'prs', 'patches', 'search', 'operations']) {
    await click(`[data-repository-section="${id}"] button[aria-expanded]`)
    await check(id + '-expands-in-place', `document.querySelector('#repository-${id}').hidden === false && document.querySelector('canvas') === window.__workspaceCanvas && document.querySelector('canvas').getBoundingClientRect().height > 600 && !document.querySelector('[data-central-editor]')`)
    if (['worktrees', 'submodules', 'mrs', 'prs', 'patches', 'search'].includes(id)) {
      await verifyInlineWidth(id)
    }
    await click(`[data-repository-section="${id}"] button[aria-expanded]`)
  }
  await click('[data-repository-section="operations"] button[aria-expanded]')
  for (const [id, label] of [['sync','Synchronisation'], ['activity','Journal d’activité'], ['tools','Outils externes']]) {
    await evaluate(client, `Array.from(document.querySelectorAll('#repository-operations button')).find((button) => button.textContent === ${JSON.stringify(label)}).click()`)
    await waitFor(client, `document.querySelector('[data-repository-tool="${id}"]') !== null`, 'inline ' + id)
    await verifyInlineWidth(id)
  }
  await click('[data-repository-section="local"] [data-ref="refs/heads/feature"]')
  await waitFor(client, `document.querySelector('aside[aria-label="Détail du commit"]') !== null`, 'selected branch commit')
  await check('single-click-selects-without-checkout', `!window.__workspaceCalls.some(([name]) => name === 'branch_checkout')`)
  await evaluate(client, `(() => {
    window.__operationOverride = null; window.__conflictsOverride = { files:[] }
    window.__generationOverride = 5
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:5, areas:['state'] })
    return true
  })()`)
  await waitFor(client, `!document.body.innerText.includes('Opération en cours :')`, 'clean branch checkout state')
  await evaluate(client, `document.querySelector('[data-repository-section="local"] [data-ref="refs/heads/feature"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'branch_checkout')`, 'direct branch checkout')
  await check('checkout-keeps-workspace', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)

  await click('[data-repository-section="stash"] button[aria-expanded]')
  await click('[data-stash="stash@{0}"]')
  await check('stash-selects-in-graph', `document.querySelector('[data-stash="stash@{0}"]').getAttribute('aria-current') === 'true' && !document.querySelector('[data-repository-tool="stash"], [data-central-editor]')`)
  const stashMenu = async () => {
    await evaluate(client, `document.querySelector('[data-stash="stash@{0}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:120, clientY:300 }))`)
    await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'stash actions')
  }
  await stashMenu()
  await check('stash-actions-on-object', `['Appliquer le stash','Appliquer et supprimer','Supprimer le stash'].every((text) => document.querySelector('[role="menu"]').textContent.includes(text))`)
  await evaluate(client, `Array.from(document.querySelectorAll('[role="menu"] button')).find((button) => button.textContent.includes('Appliquer')).click()`)
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_apply')`, 'direct stash apply')
  await check('stash-apply-has-no-dedicated-view', `!document.querySelector('[data-repository-tool="stash"], [data-central-editor]')`)
  await screenshot('workspace-stash.png')
  // The graph row exposes the same stash operations as its repository entry.
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas'); canvas.parentElement.scrollTop = 0
    const box = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:box.left + box.width * .7, clientY:box.top + 15 }))
    return true
  })()`)
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'stash graph menu')
  await check('stash-actions-in-graph', `document.querySelector('[role="menu"]').textContent.includes('Appliquer et supprimer le stash')`)
  await evaluate(client, `Array.from(document.querySelectorAll('[role="menu"] button')).find((button) => button.textContent.includes('Appliquer et supprimer')).click()`)
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_pop') && !document.querySelector('[data-stash="stash@{0}"]')`, 'direct stash pop')
  await click('[data-repository-section="stash"] button[aria-label="Stash +"]')
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_create') && Boolean(document.querySelector('[data-stash="stash@{0}"]'))`, 'direct stash create')
  await check('stash-create-has-no-form', `!document.querySelector('[data-repository-tool="stash"], [data-central-editor], [role="dialog"]')`)
  await stashMenu()
  await evaluate(client, `Array.from(document.querySelectorAll('[role="menu"] button')).find((button) => button.textContent.trim() === 'Supprimer le stash').click()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]') !== null`, 'stash deletion confirmation')
  await evaluate(client, `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === 'Supprimer').click()`)
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_drop') && !document.querySelector('[data-stash="stash@{0}"]')`, 'direct stash delete')
  await check('stash-delete-keeps-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)


  await evaluate(client, `Array.from(document.querySelectorAll('aside[aria-label="Détail du commit"] button')).find((button) => button.textContent.includes('Voir le diff complet')).click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Fichiers modifiés"]') !== null`, 'multi-file diff')
  await check('diff-file-list-compact', `(() => {
    const list = document.querySelector('aside[aria-label="Fichiers modifiés"]')
    return list.getBoundingClientRect().width <= 230 && list.getBoundingClientRect().width <= list.parentElement.getBoundingClientRect().width * .25
  })()`)
  await screenshot('workspace-compact-file-list.png')
  await evaluate(client, `(() => {
    window.__workspaceSingleDiff = true; window.__generationOverride = 120
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:120, areas:['state'] })
    return true
  })()`)
  await waitFor(client, `!document.querySelector('aside[aria-label="Fichiers modifiés"]')`, 'single-file diff uses full width')
  await check('single-file-diff-no-redundant-list', `Boolean(document.querySelector('[data-central-editor]')) && !document.querySelector('aside[aria-label="Fichiers modifiés"]')`)
  await screenshot('workspace-single-file-diff.png')
  await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
  await evaluate(client, `(() => { window.__workspaceSingleDiff = false; return true })()`)

  await click('button[data-role="worktree"]')
  await waitFor(client, `document.querySelector('button[title="src/module-1.ts"]') !== null`, 'working files')
  await click('button[title="src/module-1.ts"]')
  await waitFor(client, `document.querySelector('[data-central-editor] [data-diff-emphasis]') !== null`, 'central code diff')
  await check('diff-replaces-center', `document.querySelector('canvas').closest('[hidden]') !== null && Boolean(document.querySelector('[data-central-editor]'))`)
  await check('diff-keeps-repository-and-files', `Boolean(document.querySelector('aside[aria-label="Explorateur du dépôt"]')) && Boolean(document.querySelector('aside[aria-label="Préparation du prochain commit"]'))`)
  await screenshot('workspace-diff.png')
  await click('button[aria-label="Fermer l’aperçu"]')
  await check('closing-diff-restores-same-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('canvas').closest('[hidden]')`)

  await evaluate(client, `(() => {
    window.__operationOverride = { kind:'merge' }; window.__conflictsOverride = { files:['src/main.rs'] }
    window.__generationOverride = 6
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:6, areas:['state'] })
    return true
  })()`)
  await waitFor(client, `document.body.innerText.includes('Opération en cours :')`, 'merge conflict state')
  await evaluate(client, `Array.from(document.querySelectorAll('main button')).find((button) => button.textContent.trim() === 'Résoudre').click()`)
  await waitFor(client, `document.querySelector('[data-central-editor] input, [data-central-editor] textarea') !== null`, 'central conflict editor')
  await check('conflicts-replace-center', `document.querySelector('canvas').closest('[hidden]') !== null && !document.querySelector('[class*="historyTool"]')`)
  await screenshot('workspace-conflicts.png')
  await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
  await check('closing-conflicts-restores-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)
  const { runHubsSmoke } = await import('./hubs-smoke.mjs')
  await runHubsSmoke({ client, evaluate, screenshot, waitFor, delay, check, click })
  for (const width of [1440,1024,390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false })
    await delay(80)
    await check('viewport-' + width, `document.documentElement.scrollWidth <= innerWidth && document.querySelector('canvas').getBoundingClientRect().height > 500`)
  }
  await writeFile(join(outDir, 'workspace-checks.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ ok:true, checks:Object.keys(results).length, results }, null, 2))
}
