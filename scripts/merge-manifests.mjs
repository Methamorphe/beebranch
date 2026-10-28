// Merge per-platform update manifest fragments into one signed-update
// manifest, then optionally emit rollback.json from the previous release.
//
// Usage:
//   node scripts/merge-manifests.mjs --dir target/update/fragments \
//     --version 0.4.0 --notes docs/releases/0.4.0.md \
//     --out target/update/latest.json \
//     [--rollback target/update/previous/latest.json]

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function argsOf(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    const key = argv[index].slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) args[key] = true
    else {
      args[key] = value
      index += 1
    }
  }
  return args
}

const args = argsOf(process.argv.slice(2))
const dir = resolve(args.dir ?? 'target/update/fragments')
const out = resolve(args.out ?? 'target/update/latest.json')
const version = args.version
if (!version) {
  console.error('--version is required')
  process.exit(2)
}

const platforms = {}
for (const name of await readdir(dir)) {
  if (!name.endsWith('.json')) continue
  const fragment = JSON.parse(await readFile(join(dir, name), 'utf8'))
  for (const [target, release] of Object.entries(fragment.platforms ?? {})) {
    if (!release?.signature || !release?.url) {
      throw new Error(`unsigned platform ${target} in ${name}`)
    }
    platforms[target] = release
  }
}
if (Object.keys(platforms).length === 0) {
  throw new Error('no platform fragment found')
}

const notes = args.notes
  ? (await readFile(args.notes, 'utf8')).trim()
  : `BeeBranch ${version}`
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
}
await mkdir(resolve(out, '..'), { recursive: true })
await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${out} (${Object.keys(platforms).join(', ')})`)

if (args.rollback) {
  const previous = JSON.parse(await readFile(args.rollback, 'utf8'))
  const rollback = {
    ...previous,
    notes: `Rollback signé vers ${previous.version}. ${previous.notes ?? ''}`.trim(),
    pub_date: new Date().toISOString(),
  }
  const rollbackOut = out.replace(/latest\.json$/, 'rollback.json')
  await writeFile(rollbackOut, `${JSON.stringify(rollback, null, 2)}\n`)
  console.log(`wrote ${rollbackOut} (${previous.version})`)
}
