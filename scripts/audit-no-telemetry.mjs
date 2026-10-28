// Fail if the application embeds a telemetry/analytics SDK or endpoint.
//
// BeeBranch is local-first: the only outbound requests are GitLab (user
// configured), Git remotes, and the signed update manifest. This audit scans
// application source only (not docs, tests fixtures or dependencies).

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const roots = ['src', 'crates', 'src-tauri'].map((path) => join(root, path))
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.rs', '.json', '.html', '.css'])
const forbidden = [
  /\bsentry\b/i,
  /posthog/i,
  /mixpanel/i,
  /segment\.io/i,
  /google-analytics/i,
  /googletagmanager/i,
  /analytics\.js/i,
  /telemetry/i,
  /amplitude/i,
  /datadog/i,
  /newrelic/i,
]
const allow = [
  // The word is allowed in documentation-oriented comments that state the
  // absence of telemetry. The check below only inspects code identifiers.
  /no telemetry/i,
  /aucune télémétrie/i,
  /sans télémétrie/i,
]

async function walk(path, result = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'gen') continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      await walk(child, result)
    } else if (extensions.has(extname(entry.name))) {
      result.push(child)
    }
  }
  return result
}

const findings = []
for (const directory of roots) {
  for (const file of await walk(directory)) {
    const text = await readFile(file, 'utf8')
    for (const pattern of forbidden) {
      const match = text.match(pattern)
      if (!match) continue
      const lineStart = text.lastIndexOf('\n', match.index ?? 0) + 1
      const lineEnd = text.indexOf('\n', match.index ?? 0)
      const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
      if (allow.some((allowed) => allowed.test(line))) continue
      findings.push(`${file.replace(root + '/', '')}: ${line.trim()}`)
    }
  }
}

if (findings.length > 0) {
  console.error('Telemetry/analytics references found:')
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
console.log('No telemetry or analytics reference found in application sources.')
