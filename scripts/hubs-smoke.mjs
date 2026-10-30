export async function runHubsSmoke({ client, evaluate, screenshot, waitFor, delay, check, click }) {
  for (const provider of ['gitlab', 'github']) {
    await check(provider + '-always-accessible', `(() => {
      const link = document.querySelector('[data-forge-link="${provider}"]')
      const rect = link?.getBoundingClientRect()
      return Boolean(rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight)
    })()`)
    await click(`[data-forge-link="${provider}"]`)
    await waitFor(client, `document.querySelector('#${provider}-tab-reviews[aria-selected="true"]') !== null`, provider + ' hub')
    await check(provider + '-reviews-default', `document.querySelector('#${provider}-panel-reviews').hidden === false && document.querySelector('canvas').closest('[hidden]') !== null`)
    await check(provider + '-name-visible', `document.querySelector('[data-forge="${provider}"] header h2').textContent === ${JSON.stringify(provider === 'gitlab' ? 'GitLab' : 'GitHub')}`)
    await screenshot('hub-' + provider + '-reviews.png')
    await click(`#${provider}-tab-projects`)
    await waitFor(client, `document.querySelector('#${provider}-panel-projects').textContent.includes('team/')`, provider + ' repositories')
    await check(provider + '-repositories-tab', `document.querySelector('#${provider}-panel-projects').hidden === false && document.querySelector('#${provider}-panel-reviews').hidden === true`)
    await screenshot('hub-' + provider + '-projects.png')
    await click(`#${provider}-tab-connection`)
    await check(provider + '-connection-tab', `document.querySelector('#${provider}-panel-connection').hidden === false`)
    await screenshot('hub-' + provider + '-connection.png')
    for (const width of [1024, 390]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false })
      await delay(60)
      for (const tab of ['projects', 'connection', 'reviews']) {
        await click(`#${provider}-tab-${tab}`)
        await check(provider + '-' + tab + '-fits-' + width, `document.documentElement.scrollWidth <= innerWidth && (() => {
          const root = document.querySelector('[data-forge="${provider}"]')
          return root.scrollWidth <= root.clientWidth + 1
        })()`)
      }
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false })
    await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
    // Exercise browser authorization from the primary connection action.
    await evaluate(client, `(() => { window.__${provider}Disconnected = true; window.__${provider === 'gitlab' ? 'gitlabDevicePolls' : 'devicePolls'} = 0; return true })()`)
    await click(`[data-forge-link="${provider}"]`)
    await waitFor(client, `document.querySelector('#${provider}-panel-connection').hidden === false`, provider + ' sign in')
    await check(provider + '-manual-form-collapsed', `!document.querySelector('#${provider}-panel-connection details[class*="advanced"]').open`)
    await screenshot('hub-' + provider + '-sign-in.png')
    await evaluate(client, `Array.from(document.querySelectorAll('#${provider}-panel-connection button')).find((button) => button.textContent.includes(${JSON.stringify(provider === 'gitlab' ? 'Se connecter avec GitLab.com' : 'Se connecter avec GitHub')})).click()`)
    await waitFor(client, `document.querySelector('#${provider}-panel-connection').textContent.includes('${provider === 'gitlab' ? 'WXYZ-9876' : 'ABCD-1234'}')`, provider + ' device code')
    await waitFor(client, `document.querySelector('#${provider}-tab-reviews[aria-selected="true"]') !== null`, provider + ' authorization complete')
    await check(provider + '-authorization-keeps-hub', `Boolean(document.querySelector('[data-forge="${provider}"]')) && window.__openUrls.some((url) => url.includes('${provider}.com'))`)
    await evaluate(client, `(() => { window.__${provider}Disconnected = false; return true })()`)
    await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
  }

  await evaluate(client, `(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__workspaceHubCalls = []
    window.__hubWorkspaces = []
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      window.__workspaceHubCalls.push([command,args])
      if (command === 'workspace_list') return window.__hubWorkspaces
      if (command === 'workspace_create') {
        const created = { id:'ws_hub_' + window.__hubWorkspaces.length, name:args.request.name, repos:[], createdAt:1, updatedAt:1 }
        window.__hubWorkspaces = [...window.__hubWorkspaces, created]; return created
      }
      if (command === 'workspace_add_repo') {
        if (args.request.path === '/tmp/not-git') throw { code:'repo.not_git', message:'Not a Git repository' }
        const workspace = window.__hubWorkspaces.find((item) => item.id === args.request.workspaceId)
        const updated = { ...workspace, repos:[...workspace.repos, { path:args.request.path, name:args.request.path.split('/').at(-1), addedAt:1 }] }
        window.__hubWorkspaces = window.__hubWorkspaces.map((item) => item.id === updated.id ? updated : item)
        return updated
      }
      if (command === 'workspace_status') {
        const workspace = window.__hubWorkspaces.find((item) => item.id === args.request.workspaceId)
        return (workspace?.repos ?? []).map((repo) => ({ path:repo.path, name:repo.name, available:true, repoId:'repo_demo', state:{ head:{kind:'branch', name:'main'}, worktree:{staged:0,unstaged:0,untracked:0,conflicted:0}, conflicts:{files:[]} } }))
      }
      return original(command,args)
    }
    return true
  })()`)
  await click('button[aria-label="Sélecteur de workspace"]')
  await evaluate(client, `Array.from(document.querySelectorAll('[role="menu"] button')).find((button) => button.textContent.includes('Gérer les workspaces')).click()`)
  await waitFor(client, `document.querySelector('input[aria-label="Nom du nouveau workspace"]') !== null`, 'workspace creation')
  await screenshot('hub-workspace-create.png')
  const picker = async (selection) => {
    await evaluate(client, `(() => { window.__pickerSelection = ${JSON.stringify(selection)}; return true })()`)
    await evaluate(client, `Array.from(document.querySelectorAll('[data-central-editor="workspaces"] button')).find((button) => button.textContent.includes('Choisir des dépôts')).click()`)
    await delay(100)
  }
  await picker(null)
  await check('workspace-picker-cancel-no-mutation', `!window.__workspaceHubCalls.some(([name]) => name === 'workspace_create' || name === 'workspace_add_repo')`)
  await picker(['/tmp/hub-one', '/tmp/hub-two', '/tmp/hub-one'])
  await check('workspace-native-multiple-picker', `window.__pickerCalls.at(-1).directory === true && window.__pickerCalls.at(-1).multiple === true`)
  await check('workspace-draft-deduplicated', `document.querySelectorAll('[class*="draftRepo"]').length === 2 && !window.__workspaceHubCalls.some(([name]) => name === 'workspace_add_repo')`)
  await evaluate(client, `(() => {
    const input = document.querySelector('input[aria-label="Nom du nouveau workspace"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Mon équipe')
    input.dispatchEvent(new Event('input', {bubbles:true})); return true
  })()`)
  await screenshot('hub-workspace-ready.png')
  await evaluate(client, `Array.from(document.querySelectorAll('[data-central-editor="workspaces"] button')).find((button) => button.textContent.trim() === 'Créer le workspace').click()`)
  await waitFor(client, `document.querySelector('#workspace-detail-title')?.textContent === 'Mon équipe'`, 'created workspace')
  await check('workspace-created-with-picked-folders', `window.__workspaceHubCalls.filter(([name]) => name === 'workspace_add_repo').length === 2 && window.__hubWorkspaces[0].repos.length === 2`)
  await check('workspace-manual-path-optional', `!document.querySelector('details[class*="manualPath"]').open`)
  await screenshot('hub-workspace-created.png')
  await picker(['/tmp/hub-two', '/tmp/hub-three'])
  await waitFor(client, `window.__hubWorkspaces[0].repos.length === 3`, 'add repository with native picker')
  await check('workspace-existing-add-deduplicated', `window.__workspaceHubCalls.filter(([name]) => name === 'workspace_add_repo').length === 3`)
  const beforeLimit = await evaluate(client, `window.__workspaceHubCalls.filter(([name]) => name === 'workspace_add_repo').length`)
  await picker(Array.from({length:21}, (_, index) => '/tmp/hub-over-limit-' + index))
  await waitFor(client, `document.querySelector('[data-central-editor="workspaces"] [role="alert"]')?.textContent.includes('maximum 20')`, 'workspace repository limit')
  await check('workspace-picker-enforces-limit', `window.__workspaceHubCalls.filter(([name]) => name === 'workspace_add_repo').length === ${beforeLimit}`)
  await picker('/tmp/not-git')
  await waitFor(client, `document.querySelector('[data-central-editor="workspaces"] [role="alert"]')?.textContent.includes('Not a Git repository')`, 'invalid folder feedback')
  await check('workspace-invalid-folder-keeps-repositories', `window.__hubWorkspaces[0].repos.length === 3`)
  for (const width of [1440, 1024, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false })
    await delay(60)
    await check('workspace-manager-fits-' + width, `document.documentElement.scrollWidth <= innerWidth && (() => {
      const root = document.querySelector('[class*="workspaceDetail"]').parentElement
      return root.scrollWidth <= root.clientWidth + 1
    })()`)
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false })
  await click('button[aria-label="Fermer le panneau et revenir à l’arbre"]')
}
