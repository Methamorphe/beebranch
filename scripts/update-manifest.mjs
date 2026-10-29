// Build a signed-update manifest from Tauri bundle signatures.
//
// Usage:
//   node scripts/update-manifest.mjs --dir target/release/bundle \
//     --version 0.4.0 --base-url https://updates.example/releases/0.4.0 \
//     --notes docs/releases/0.4.0.md --out target/update/latest.json \
//     [--target darwin-aarch64] [--rollback target/update/previous-latest.json]
//
// Artifacts must have been produced by `tauri build` with
// `TAURI_SIGNING_PRIVATE_KEY` set, which writes one `.sig` file per bundle.
// The script refuses to publish an artifact that has no signature.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = value
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const dir = resolve(args.dir ?? 'target/release/bundle')
const version = args.version
const baseUrl = (args['base-url'] ?? '').replace(/\/$/, '')
const notesPath = args.notes
const out = resolve(args.out ?? 'target/update/latest.json')

if (!version || !baseUrl) {
  console.error(
    'usage: update-manifest.mjs --dir <bundle> --version <v> --base-url <url> [--notes <file>] [--out <json>] [--rollback <json>]',
  )
  process.exit(2)
}

async function walk(path, result = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      await walk(child, result)
    } else {
      result.push(child)
    }
  }
  return result
}

function platformOf(file) {
  const name = basename(file).toLowerCase()
  const architecture = /aarch64|arm64/.test(name)
    ? 'aarch64'
    : /x86_64|x64|amd64/.test(name)
      ? 'x86_64'
      : null
  if (!architecture) return null
  if (name.endsWith('.app.tar.gz')) return `darwin-${architecture}`
  if (name.endsWith('.appimage.tar.gz')) return `linux-${architecture}`
  // Tauri v2 reuses the NSIS installer as the updater artifact; the .zip
  // layout only exists with `createUpdaterArtifacts: "v1Compatible"`.
  // MSI is ignored on purpose: BeeBranch updates through the NSIS installer,
  // and two updater artifacts for one platform would fight over the entry.
  if (name.endsWith('.nsis.zip') || name.endsWith('-setup.exe')) {
    return `windows-${architecture === 'aarch64' ? 'aarch64' : 'x86_64'}`
  }
  return null
}

const files = await walk(dir)
const platforms = {}
for (const signatureFile of files.filter((file) => file.endsWith('.sig'))) {
  const artifact = signatureFile.slice(0, -4)
  if (!files.includes(artifact)) {
    throw new Error(`signature without artifact: ${signatureFile}`)
  }
  const lower = basename(artifact).toLowerCase()
  const updaterArtifact =
    lower.endsWith('.app.tar.gz') ||
    lower.endsWith('.appimage.tar.gz') ||
    lower.endsWith('.msi.zip') ||
    lower.endsWith('.nsis.zip') ||
    lower.endsWith('-setup.exe')
  if (!updaterArtifact) {
    continue
  }
  const platform = args.target ?? platformOf(artifact)
  if (!platform) {
    continue
  }
  const signature = (await readFile(signatureFile, 'utf8')).trim()
  if (!signature) {
    throw new Error(`empty signature: ${signatureFile}`)
  }
  platforms[platform] = {
    signature,
    url: `${baseUrl}/${basename(artifact)}`,
  }
}

if (Object.keys(platforms).length === 0) {
  throw new Error('no signed updater artifact found')
}

const notes = notesPath
  ? (await readFile(notesPath, 'utf8')).trim()
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
