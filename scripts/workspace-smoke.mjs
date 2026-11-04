import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runRepositoryWorkspaceSmoke({ client, evaluate, screenshot, waitFor, delay, outDir }) {
  const results = {}
  const check = async (name, expression) => {
    results[name] = Boolean(await evaluate(client, expression))
    if (!results[name]) throw new Error('Repository workspace: ' + name)
  }
  /** Confirm the pre-operation bar opened by the last action. */
  const confirmPreview = async () => {
    await waitFor(client, `(() => { const bar = document.querySelector('[role="alertdialog"]'); const button = bar ? [...bar.querySelectorAll('button')].at(-1) : null; return Boolean(button) && !button.disabled })()`, 'operation preview')
    await evaluate(client, `(() => { const bar = document.querySelector('[role="alertdialog"]'); [...bar.querySelectorAll('button')].at(-1).click(); return true })()`)
    await delay(60)
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
      if (command === 'branch_create') {
        return { data: { name: args.request.name, exists:false, current:true, merged:false, ahead:0, behind:0, worktreeDirty:false }, generation:4 }
      }
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
  // Dwell on the feature badge: only its ancestry should keep full contrast.
  await evaluate(client, `(() => { const canvas = document.querySelector('canvas'); canvas.parentElement.scrollTop = 0; canvas.parentElement.dispatchEvent(new Event('scroll')); })()`)
  await delay(60)
  const featurePoint = await evaluate(client, `(() => { const b = document.querySelector('canvas').getBoundingClientRect(); return { x:b.left+20, y:b.top+12*30+15 } })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:featurePoint.x, y:featurePoint.y })
  await delay(100)
  await check('graph-branch-focus-waits-for-dwell', `!document.querySelector('canvas').dataset.branchFocus`)
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    window.__focusPixels = (row) => {
      const scale = canvas.width / canvas.getBoundingClientRect().width
      return Array.from(canvas.getContext('2d').getImageData(0, Math.round(row * 30 * scale), canvas.width, Math.round(30 * scale)).data).join(',')
    }
    window.__beforeFocus = [window.__focusPixels(2), window.__focusPixels(13)]
  })()`)
  await delay(500)
  await check('graph-branch-focus-activates', `document.querySelector('canvas').dataset.branchFocus === '000000000000000000000000000000000000000d'`)
  await check('graph-branch-focus-dims-unrelated-row', `window.__focusPixels(2) !== window.__beforeFocus[0]`)
  await check('graph-branch-focus-preserves-ancestor-row', `window.__focusPixels(13) === window.__beforeFocus[1]`)
  await screenshot('workspace-branch-focus.png')
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:featurePoint.x + 400, y:featurePoint.y })
  await delay(60)
  await check('graph-branch-focus-clears-on-leave', `!document.querySelector('canvas').dataset.branchFocus && window.__focusPixels(2) === window.__beforeFocus[0]`)
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:featurePoint.x, y:featurePoint.y })
  await evaluate(client, `document.querySelector('canvas').parentElement.dispatchEvent(new Event('scroll'))`)
  await delay(500)
  await check('graph-branch-focus-cancels-pending-on-scroll', `!document.querySelector('canvas').dataset.branchFocus`)
  await screenshot('workspace-tree.png')
  await evaluate(client, `document.documentElement.dataset.density = 'compact'`)
  await delay(300)
  await screenshot('workspace-graph-compact.png')
  await evaluate(client, `document.documentElement.dataset.density = 'comfortable'`)

  // A tag row reveals the commit the tag points at: an annotated tag stores a
  // tag object, which is never a row of the history. The reveal runs in an
  // effect after the click, and the mock tag targets a commit below the fold.
  await click('[data-repository-section="tags"] button[aria-expanded]')
  await click('[data-ref="refs/tags/v0.1"]')
  await waitFor(client, `document.querySelector('[data-role="graph-selection"]').textContent === 'Commit 301 — fix graph lanes'`, 'tag reveals its commit')
  await check('tag-row-reveals-commit', `(() => {
    const row = document.querySelector('[data-ref="refs/tags/v0.1"]')
    const selection = document.querySelector('[data-role="graph-selection"]').textContent
    const canvas = document.querySelector('canvas')
    let scroller = canvas && canvas.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement
    return row.getAttribute('aria-current') === 'true'
      && selection === 'Commit 301 — fix graph lanes'
      && Boolean(scroller) && scroller.scrollTop > 0
      && Boolean(document.querySelector('aside[aria-label="Détail du commit"]'))
  })()`)
  await click('[data-repository-section="tags"] button[aria-expanded]')

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
    if (id === 'sync') {
      // A forced push asks once: the force bar replaces the push summary, so
      // accepting it must send the push instead of opening a second bar.
      await waitFor(client, `(() => {
        const panel = document.querySelector('[data-repository-tool="sync"]')
        const push = [...panel.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Push')
        return Boolean(push) && !push.disabled
      })()`, 'sync push enabled')
      await evaluate(client, `(() => {
        window.__syncOriginalInvoke = window.__TAURI_INTERNALS__.invoke
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (command === 'sync_push') {
            window.__workspaceCalls.push([command, args])
            return { data:{ kind:'push', output:'', cancelled:false }, generation: 6 }
          }
          return window.__syncOriginalInvoke(command, args)
        }
        return true
      })()`)
      await check('sync-force-option', `(() => {
        const panel = document.querySelector('[data-repository-tool="sync"]')
        const label = [...panel.querySelectorAll('label')].find((entry) => entry.textContent.includes('force-with-lease'))
        const box = label?.querySelector('input[type="checkbox"]')
        if (!box) return false
        box.click()
        return box.checked
      })()`)
      await evaluate(client, `(() => {
        const panel = document.querySelector('[data-repository-tool="sync"]')
        const push = [...panel.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Push')
        push.click()
        return true
      })()`)
      await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('Force push') === true`, 'force push bar')
      await check('force-push-asks-before-sending', `(() => {
        const dialog = document.querySelector('[role="alertdialog"]')
        return Boolean(dialog)
          && dialog.innerText.includes('Force push')
          && !dialog.innerText.includes('Attention')
          && !(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.force === true)
      })()`)
      await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Force push')).click()`)
      await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('Attention') === true`, 'force push warning')
      await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Confirmer')).click()`)
      await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.force === true)`, 'force push sent')
      await check('force-push-asks-once', `!document.querySelector('[role="alertdialog"]')`)
      await check('force-push-sends-lease-confirmation', `(() => {
        const call = [...(window.__workspaceCalls ?? [])].reverse().find(([command, args]) => command === 'sync_push' && args.request.force === true)
        return Boolean(call) && call[1].request.confirmation.acknowledged === true && call[1].request.branch === 'main'
      })()`)
      await evaluate(client, `(() => { window.__TAURI_INTERNALS__.invoke = window.__syncOriginalInvoke; return true })()`)
      await delay(120)
    }
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
  await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('Basculer sur feature') === true`, 'checkout preview')
  await check('checkout-preview-read-first', `(window.__workspaceCalls ?? []).some(([name]) => name === 'operation_preview')`)
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Annuler')).click()`)
  await delay(60)
  await check('checkout-preview-cancel-does-nothing', `!(window.__workspaceCalls ?? []).some(([name]) => name === 'branch_checkout')`)
  await evaluate(client, `document.querySelector('[data-repository-section="local"] [data-ref="refs/heads/feature"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }))`)
  await confirmPreview()
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'branch_checkout')`, 'direct branch checkout')
  await check('checkout-keeps-workspace', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)

  // Issue #19: drag a graph branch onto a left-panel local branch.
  await evaluate(client, `(() => { const c = document.querySelector('canvas'); c.parentElement.scrollTop = 0; c.parentElement.dispatchEvent(new Event('scroll')); })()`)
  await delay(80)
  const navDrop = await evaluate(client, `(() => {
    const bounds = document.querySelector('canvas').getBoundingClientRect()
    const row = document.querySelector('[data-repository-section="local"] [data-ref="refs/heads/main"]')
    const rowBounds = row.getBoundingClientRect()
    return {
      source: { x: bounds.left + 20, y: bounds.top + 12 * 30 + 15 },
      target: { x: rowBounds.left + rowBounds.width / 2, y: rowBounds.top + rowBounds.height / 2 },
    }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, buttons:1, x: navDrop.source.x, y: navDrop.source.y })
  for (const ratio of [0.2, 0.4, 0.6, 0.8, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      x: navDrop.source.x + (navDrop.target.x - navDrop.source.x) * ratio,
      y: navDrop.source.y + (navDrop.target.y - navDrop.source.y) * ratio,
    })
    await delay(45)
  }
  await check(
    'navigator-drop-highlight',
    `document.querySelector('[data-repository-section="local"] [data-ref="refs/heads/main"][data-drop="true"]') !== null`,
  )
  await check(
    'navigator-drop-ghost',
    `(() => { const ghost = document.querySelector('[class*=dragGhost]'); return Boolean(ghost && ghost.innerText.includes('feature') && ghost.innerText.includes('main')) })()`,
  )
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, buttons:0, x: navDrop.target.x, y: navDrop.target.y })
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'navigator drop menu')
  await check(
    'navigator-drop-menu',
    `(() => {
      const menu = document.querySelector('[role="menu"]')
      return Boolean(menu && menu.innerText.includes('Fusionner feature dans main') && menu.innerText.includes('Avance rapide : main sur feature') && menu.innerText.includes('Rebaser feature sur main'))
    })()`,
  )
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(80)
  await check('navigator-drop-cancel', `!document.querySelector('[role="menu"]')`)

  // Choosing Merge applies it at once: the choice a merge used to ask —
  // fast-forward or merge commit — is the separate menu action above.
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, buttons:1, x: navDrop.source.x, y: navDrop.source.y })
  for (const ratio of [0.2, 0.4, 0.6, 0.8, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      x: navDrop.source.x + (navDrop.target.x - navDrop.source.x) * ratio,
      y: navDrop.source.y + (navDrop.target.y - navDrop.source.y) * ratio,
    })
    await delay(45)
  }
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, buttons:0, x: navDrop.target.x, y: navDrop.target.y })
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'navigator drop menu again')
  await evaluate(client, `([...document.querySelectorAll('[role="menu"] button')].find((button) => button.textContent.includes('Fusionner feature dans main'))).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command]) => command === 'branch_integration_start')`, 'direct merge')
  await check('navigator-drop-merge-applies-at-once', `!document.querySelector('[role="alertdialog"]')`)
  await check('navigator-drop-merge-defaults-to-fast-forward', `(() => {
    const call = (window.__workspaceCalls ?? []).find(([command]) => command === 'branch_integration_start')
    return Boolean(call) && call[1].request.mode === 'merge'
      && call[1].request.source === 'feature' && call[1].request.target === 'main'
      && call[1].request.fastForward === 'auto' && call[1].request.confirmation.acknowledged === true
  })()`)
  await waitFor(client, `document.body.innerText.includes('Fusion de feature appliqué')`, 'merge notice')

  // The fast-forward action stays a separate choice and sends `--ff-only`.
  await evaluate(client, `(() => {
    window.__mergeStarts = (window.__workspaceCalls ?? []).filter(([command]) => command === 'branch_integration_start').length
    return true
  })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, buttons:1, x: navDrop.source.x, y: navDrop.source.y })
  for (const ratio of [0.2, 0.4, 0.6, 0.8, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      x: navDrop.source.x + (navDrop.target.x - navDrop.source.x) * ratio,
      y: navDrop.source.y + (navDrop.target.y - navDrop.source.y) * ratio,
    })
    await delay(45)
  }
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, buttons:0, x: navDrop.target.x, y: navDrop.target.y })
  await waitFor(client, `document.querySelector('[role="menu"]') !== null`, 'navigator drop menu for fast-forward')
  await evaluate(client, `([...document.querySelectorAll('[role="menu"] button')].find((button) => button.textContent.includes('Avance rapide : main sur feature'))).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).filter(([command]) => command === 'branch_integration_start').length > window.__mergeStarts`, 'fast-forward merge')
  await check('navigator-drop-fast-forward-sends-ff-only', `(() => {
    const calls = (window.__workspaceCalls ?? []).filter(([command]) => command === 'branch_integration_start')
    const call = calls[calls.length - 1]
    return Boolean(call) && call[1].request.mode === 'merge' && call[1].request.fastForward === 'only'
      && call[1].request.confirmation.acknowledged === true && !document.querySelector('[role="alertdialog"]')
  })()`)

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
  await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('src/main.rs') === true`, 'stash pop preview lists conflicts')
  await check('stash-pop-preview-summary', `(() => {
    const bar = document.querySelector('[role="alertdialog"]')
    return bar.innerText.includes('conflit') && bar.innerText.includes('2 fichiers')
  })()`)
  await confirmPreview()
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_pop') && !document.querySelector('[data-stash="stash@{0}"]')`, 'direct stash pop')
  await click('[data-repository-section="stash"] button[aria-label="Stash +"]')
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_create') && Boolean(document.querySelector('[data-stash="stash@{0}"]'))`, 'direct stash create')
  await check('stash-create-has-no-form', `!document.querySelector('[data-repository-tool="stash"], [data-central-editor], [role="dialog"]')`)
  await stashMenu()
  await evaluate(client, `Array.from(document.querySelectorAll('[role="menu"] button')).find((button) => button.textContent.trim() === 'Supprimer le stash').click()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]') !== null`, 'stash deletion confirmation')
  await evaluate(client, `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === 'Supprimer').click()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('Attention') === true`, 'stash deletion warning step')
  await evaluate(client, `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === 'Confirmer').click()`)
  await waitFor(client, `window.__workspaceCalls.some(([name]) => name === 'stash_drop') && !document.querySelector('[data-stash="stash@{0}"]')`, 'direct stash delete')
  await check('stash-delete-keeps-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)


  await evaluate(client, `Array.from(document.querySelectorAll('aside[aria-label="Détail du commit"] button')).find((button) => button.textContent.includes('Voir le diff complet')).click()`)
  await waitFor(client, `document.querySelector('aside[aria-label="Fichiers modifiés"]') !== null`, 'multi-file diff')
  await waitFor(client, `document.querySelector('[data-diff-file="assets/logo.png"]') !== null`, 'image file in the diff list')
  await evaluate(client, `document.querySelector('[data-diff-file="assets/logo.png"]').click()`)
  await waitFor(client, `document.querySelectorAll('[data-image-view] img').length === 2`, 'image diff sides')
  await check('image-diff-shows-both-sides', `(() => {
    const captions = [...document.querySelectorAll('[data-image-view] figcaption')].map((node) => node.textContent)
    return captions.length === 2 && captions.some((text) => text.includes('Avant')) && captions.some((text) => text.includes('Après'))
  })()`)
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
  // The region choice leaves an unsaved draft: the discard prompt is accepted
  // by the smoke's dialog handler, as a user would.
  await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
  await evaluate(client, `(() => { window.__workspaceSingleDiff = false; return true })()`)

  await click('[data-role="worktree"]')
  await waitFor(client, `document.querySelector('button[title="src/module-1.ts"]') !== null`, 'working files')
  await check('worktree-single-click-opens-files', `document.querySelector('textarea[aria-label="Message de commit"]') !== null`)
  await check('wip-message-not-editable-until-double-click', `!document.querySelector('[data-role="worktree"] input')`)
  await evaluate(client, `document.querySelector('[data-wip-draft]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(client, `document.querySelector('[data-role="worktree"] input') !== null`, 'wip message field')
  await check('wip-message-double-click-edits', `document.activeElement === document.querySelector('[data-role="worktree"] input')`)
  await evaluate(client, `(() => {
    const input = document.querySelector('[data-role="worktree"] input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Message depuis le graphe')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await check('wip-message-syncs-with-commit-panel', `document.querySelector('textarea[aria-label="Message de commit"]')?.value === 'Message depuis le graphe'`)
  await evaluate(client, `(() => {
    const area = document.querySelector('textarea[aria-label="Message de commit"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, 'Depuis le panneau')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await check('commit-panel-syncs-with-wip', `document.querySelector('[data-wip-draft]')?.textContent === 'Depuis le panneau'`)
  await evaluate(client, `(() => {
    const area = document.querySelector('textarea[aria-label="Message de commit"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await click('button[title="src/module-1.ts"]')
  await waitFor(client, `document.querySelector('[data-central-editor] [data-diff-emphasis]') !== null`, 'central code diff')
  await check('diff-replaces-center', `document.querySelector('canvas').closest('[hidden]') !== null && Boolean(document.querySelector('[data-central-editor]'))`)
  await check('diff-keeps-repository-and-files', `Boolean(document.querySelector('aside[aria-label="Explorateur du dépôt"]')) && Boolean(document.querySelector('aside[aria-label="Préparation du prochain commit"]'))`)
  await screenshot('workspace-diff.png')
  await click('button[aria-label="Fermer l’aperçu"]')
  await check('closing-diff-restores-same-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('canvas').closest('[hidden]')`)

  // Right-clicking a file row exposes the same actions as the `···` popover,
  // plus the worktree deletion that only lives in the menu.
  await evaluate(client, `(() => {
    const row = document.querySelector('button[title="src/module-1.ts"]').closest('div[class*="fileRow"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:200, clientY:300 }))
    return true
  })()`)
  await waitFor(client, `Boolean(document.querySelector('[role="menu"]'))`, 'file context menu')
  await check('file-context-menu-actions', `(() => {
    const menu = document.querySelector('[role="menu"]')
    const labels = [...menu.querySelectorAll('button')].map((button) => button.textContent.trim())
    return menu.getAttribute('aria-label') === 'Actions sur le fichier src/module-1.ts'
      && labels.includes('Préparer')
      && labels.includes('Copier le chemin')
      && labels.includes('Supprimer le fichier…')
  })()`)
  await screenshot('workspace-file-context-menu.png')
  await evaluate(client, `([...document.querySelectorAll('[role="menu"] button')].find((button) => button.textContent.trim() === 'Supprimer le fichier…')).click()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'file delete confirmation')
  await check('file-delete-confirmation', `(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    return dialog.innerText.includes('Supprimer le fichier')
      && dialog.innerText.includes('src/module-1.ts')
      && dialog.innerText.includes('irréversible')
  })()`)
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.trim() === 'Supprimer')).click()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]')?.innerText.includes('Attention') === true`, 'file delete warning step')
  await screenshot('workspace-delete-warning.png')
  await evaluate(client, `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === 'Confirmer').click()`)
  await waitFor(client, `(window.__p1Calls ?? []).some(([action]) => action === 'delete')`, 'file delete call')
  await check('file-delete-call', `(() => {
    const call = (window.__p1Calls ?? []).find(([action]) => action === 'delete')
    return Boolean(call)
      && call[1].request.path === 'src/module-1.ts'
      && call[1].request.confirmation.acknowledged === true
  })()`)
  await waitFor(client, `document.querySelector('[role="alertdialog"]') === null`, 'delete confirmation closed')

  // Publishing a local branch is one explicit decision: the first push creates
  // the remote ref and records the upstream, so it asks before sending.
  await evaluate(client, `(() => {
    const canvas = document.querySelector('canvas')
    canvas.parentElement.scrollTop = 0
    canvas.parentElement.dispatchEvent(new Event('scroll'))
    return true
  })()`)
  await delay(80)
  const publishPoint = await evaluate(client, `(() => {
    const b = document.querySelector('canvas').getBoundingClientRect()
    return { x:b.left+20, y:b.top+12*30+15 }
  })()`)
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:publishPoint.x, y:publishPoint.y })
  await delay(100)
  await evaluate(client, `(() => {
    document.querySelector('canvas').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:${publishPoint.x}, clientY:${publishPoint.y} }))
    return true
  })()`)
  await waitFor(client, `Boolean(document.querySelector('[role="menu"]'))`, 'branch context menu')
  await check('branch-menu-offers-publish', `[...document.querySelectorAll('[role="menu"] button')].some((button) => button.textContent.includes('Publier vers origin/feature'))`)
  await evaluate(client, `([...document.querySelectorAll('[role="menu"] button')].find((button) => button.textContent.includes('Publier vers origin/feature'))).click()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'publish branch dialog')
  await check('branch-publish-dialog-explains-upstream', `(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    return dialog.innerText.includes('Publier la branche feature')
      && dialog.innerText.includes('origin/feature')
      && dialog.innerText.includes('upstream')
      && !(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'feature')
  })()`)
  await screenshot('workspace-publish-dialog.png')
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.includes('Pousser et créer origin/feature'))).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'feature' && args.request.setUpstream === true)`, 'publish branch push')
  await waitFor(client, `document.querySelector('[role="alertdialog"]') === null`, 'publish dialog closed')
  await check('branch-publish-sets-upstream', `true`)

  // Creating a branch the remote does not know yet offers its first push.
  await click('button[aria-label="Créer une branche"]')
  await waitFor(client, `Boolean(document.querySelector('input[aria-label="Nom de la nouvelle branche"]'))`, 'inline branch form')
  await evaluate(client, `(() => {
    const input = document.querySelector('input[aria-label="Nom de la nouvelle branche"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'publish/inline')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await delay(50)
  await click('button[aria-label="Créer la branche"]')
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'branch_create' && args.request.name === 'publish/inline')`, 'branch create call')
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'publish dialog after branch creation')
  await check('branch-creation-offers-publish', `(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    return dialog.innerText.includes('Publier la branche publish/inline')
      && dialog.innerText.includes('origin/publish/inline')
      && !(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'publish/inline')
  })()`)
  await screenshot('workspace-branch-created-publish.png')
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.includes('Pousser et créer origin/publish/inline'))).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'publish/inline' && args.request.setUpstream === true)`, 'branch creation publish push')

  // A push Git can send as-is leaves nothing to decide: the summary bar only
  // belongs to a push it would refuse, or to a forced one.
  await evaluate(client, `(() => {
    window.__pushOriginalInvoke = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'sync_push') {
        window.__workspaceCalls.push([command, args])
        return { data:{ kind:'push', output:'', cancelled:false }, generation: 6 }
      }
      return window.__pushOriginalInvoke(command, args)
    }
    return true
  })()`)
  await evaluate(client, `([...document.querySelectorAll('[aria-label="Actions Git"] button')].find((button) => button.textContent.trim() === 'Push')).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'main' && !args.request.force)`, 'fast-forward push')
  await check('push-fast-forward-has-no-bar', `!document.querySelector('[role="alertdialog"]')`)
  await check('push-fast-forward-is-previewed', `(window.__workspaceCalls ?? []).some(([command]) => command === 'operation_preview')`)
  await evaluate(client, `(() => { window.__TAURI_INTERNALS__.invoke = window.__pushOriginalInvoke; return true })()`)
  await delay(150)

  // The toolbar Push follows the same rule for a checked-out branch that has
  // no upstream: a dialog instead of the sync panel, and a push with -u.
  await evaluate(client, `(() => {
    window.__publishOriginalInvoke = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await window.__publishOriginalInvoke(command, args)
      if ((command === 'repo_get_state' || command === 'repo_refresh') && result?.state?.head?.kind === 'branch') {
        return { ...result, state:{ ...result.state, head:{ ...result.state.head, upstream: undefined } } }
      }
      return result
    }
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:5, areas:['state'] })
    return true
  })()`)
  await delay(250)
  await evaluate(client, `([...document.querySelectorAll('[aria-label="Actions Git"] button')].find((button) => button.textContent.trim() === 'Push')).click()`)
  await waitFor(client, `Boolean(document.querySelector('[role="alertdialog"]'))`, 'toolbar publish dialog')
  await check('toolbar-push-asks-to-publish', `(() => {
    const dialog = document.querySelector('[role="alertdialog"]')
    return dialog.innerText.includes('Publier la branche main')
      && dialog.innerText.includes('origin/main')
  })()`)
  await evaluate(client, `([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent.includes('Pousser et créer origin/main'))).click()`)
  await waitFor(client, `(window.__workspaceCalls ?? []).some(([command, args]) => command === 'sync_push' && args.request.branch === 'main' && args.request.setUpstream === true)`, 'toolbar publish push')
  await evaluate(client, `(() => {
    window.__TAURI_INTERNALS__.invoke = window.__publishOriginalInvoke
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:5, areas:['state'] })
    return true
  })()`)
  await delay(200)

  // The subject counter watches the first line only and warns past 72 chars.
  const setCommitMessage = (value) => evaluate(client, `(() => {
    const editor = document.querySelector('textarea[aria-label="Message de commit"]')
    if (!editor) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, ${JSON.stringify(value)})
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const readCounter = () => evaluate(client, `(() => {
    const counter = document.querySelector('[data-role="commit-subject-counter"]')
    return counter ? { text: counter.textContent.trim(), over: counter.dataset.over !== undefined, color: getComputedStyle(counter).color } : null
  })()`)
  if (!(await setCommitMessage('x'.repeat(43) + '\n\nCorps libre, sans limite de longueur.'))) {
    throw new Error('commit composer missing for the subject counter')
  }
  const assertCounter = (name, value, detail) => {
    results[name] = Boolean(value)
    if (!value) throw new Error('Repository workspace: ' + name + ' — ' + JSON.stringify(detail))
  }
  await delay(40)
  const counterUnder = await readCounter()
  assertCounter('commit-counter-counts-subject-only',
    counterUnder?.text === '29 caractères restants' && !counterUnder.over, counterUnder)
  await setCommitMessage('x'.repeat(80))
  await delay(40)
  const counterOver = await readCounter()
  assertCounter('commit-counter-warns-over-limit',
    counterOver?.text === '8 caractères au-delà de la limite (72)' && counterOver.over && counterOver.color !== counterUnder.color, counterOver)
  await setCommitMessage('')

  await evaluate(client, `(() => {
    window.__operationOverride = { kind:'merge' }; window.__conflictsOverride = { files:['src/main.rs'] }
    window.__generationOverride = 6
    window.__emitTauriEvent('repo://changed', { repoId:'repo_demo', generation:6, areas:['state'] })
    return true
  })()`)
  await waitFor(client, `document.body.innerText.includes('Opération en cours :')`, 'merge conflict state')
  await evaluate(client, `Array.from(document.querySelectorAll('main button')).find((button) => button.textContent.trim() === 'Résoudre').click()`)
  await waitFor(client, `document.querySelector('[data-central-editor] input, [data-central-editor] textarea') !== null`, 'central conflict editor')
  await waitFor(client, `document.querySelector('[aria-label="Résoudre les conflits par région"]') !== null`, 'conflict regions')
  await check('conflict-region-listed', `document.querySelector('[aria-label="Résoudre les conflits par région"]').innerText.includes('Conflit 1')`)
  await evaluate(client, `Array.from(document.querySelectorAll('[aria-label="Résoudre les conflits par région"] button')).find((button) => button.textContent.trim() === 'Garder theirs').click()`)
  await check('conflict-region-choice-writes-marker-free-result', `document.querySelector('textarea[aria-label="Résolution du conflit"]')?.value.trimEnd() === 'theirs'`)
  await check('conflicts-replace-center', `document.querySelector('canvas').closest('[hidden]') !== null && !document.querySelector('[class*="historyTool"]')`)
  await screenshot('workspace-conflicts.png')
  await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
  await check('closing-conflicts-restores-graph', `document.querySelector('canvas') === window.__workspaceCanvas && !document.querySelector('[data-central-editor]')`)
  await check('operation-shown-once', `Array.from(document.querySelectorAll('body *')).filter((element) => element.children.length === 0 && /Opération en cours|opération : merge|Opération : merge/.test(element.textContent) && element.getBoundingClientRect().width > 2).length === 1`)

  // The built-in terminal opens a PTY in the repository folder and closes it
  // when its view goes away.
  const openPaletteView = async (label) => {
    await evaluate(client, `document.querySelector('button[aria-label="Rechercher une commande"]').click()`)
    await waitFor(client, `document.querySelector('[role="combobox"]') !== null`, 'command palette')
    await evaluate(client, `(() => {
      const input = document.querySelector('[role="combobox"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(label)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await delay(80)
    await evaluate(client, `document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  }
  await openPaletteView('Terminal')
  await waitFor(client, `document.querySelector('[data-terminal]') !== null`, 'terminal view')
  await check('terminal-opens-a-pty', `(window.__terminalCalls ?? []).some(([action, args]) => action === 'open' && args.request.repoId === 'repo_demo' && args.request.rows > 0 && args.request.cols > 0)`)
  await check('terminal-shows-the-shell', `document.querySelector('[data-terminal]').innerText.includes('/bin/sh')`)
  await openPaletteView('Historique')
  await waitFor(client, `document.querySelector('[data-terminal]') === null`, 'terminal closed')
  await check('terminal-closes-its-pty', `(window.__terminalCalls ?? []).some(([action]) => action === 'close')`)

  // `?` outside a field opens the shortcut reference; Escape closes it.
  await evaluate(client, `document.activeElement?.blur()`)
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'?', text:'?', windowsVirtualKeyCode:191, modifiers:8 })
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'?', windowsVirtualKeyCode:191, modifiers:8 })
  await delay(100)
  await check('shortcut-help-opens', `document.querySelectorAll('[aria-labelledby="shortcut-help-title"] li').length >= 15`)
  await screenshot('workspace-shortcut-help.png')
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', windowsVirtualKeyCode:27 })
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', windowsVirtualKeyCode:27 })
  await delay(80)
  await check('shortcut-help-closes', `!document.querySelector('[aria-labelledby="shortcut-help-title"]')`)

  // A failed action reports through a dismissible toast carrying its remediation.
  await evaluate(client, `(() => {
    window.__toastInvoke = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'sync_fetch'
      ? Promise.reject({ code:'auth.failed', category:'auth', message:'L\\'authentification Git a échoué.', remediation:'Vérifiez le token.' })
      : window.__toastInvoke(command, args)
    return true
  })()`)
  await evaluate(client, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Fetch').click()`)
  await waitFor(client, `Array.from(document.querySelectorAll('[data-toasts] [role="alert"]')).some((toast) => toast.textContent.includes('authentification'))`, 'error toast')
  await check('error-toast-shows-remediation', `Array.from(document.querySelectorAll('[data-toasts] [role="alert"]')).some((toast) => toast.textContent.includes('Vérifiez le token.'))`)
  await screenshot('workspace-error-toast.png')
  await evaluate(client, `(() => { document.querySelectorAll('[data-toasts] button[aria-label="Fermer"]').forEach((button) => button.click()); window.__TAURI_INTERNALS__.invoke = window.__toastInvoke; return true })()`)
  await delay(60)
  await check('error-toast-dismisses', `!document.querySelector('[data-toasts] [role="alert"]')`)
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
