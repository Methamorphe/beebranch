// Verify that Tauri updater signatures were produced by the minisign key that
// clients actually trust: the pubkey embedded in `tauri.conf.json`.
//
// Usage:
//   node scripts/verify-update-signature.mjs target/release/bundle/**/*-setup.exe
//   node scripts/verify-update-signature.mjs target/release/bundle/**/*.app.tar.gz
//
// An artifact signed with another key is rejected at install time with
// `update.signature_invalid`, and a signature copied from another file is
// rejected the same way. Both cases are silent until a user tries to update,
// so they are checked before publication.

import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// Ed25519 SubjectPublicKeyInfo header, prepended to the raw 32-byte key.
const SPKI_PREFIX = '302a300506032b6570032100'

/**
 * Tauri stores minisign blobs base64-encoded on top of a text format:
 * an "untrusted comment" line, then the base64 payload. Both the pubkey and
 * the `.sig` file follow it.
 */
function decodeMinisignBlob(encoded, label) {
  if (!encoded) throw new Error(`missing ${label}`)
  const lines = Buffer.from(encoded, 'base64').toString('utf8').trim().split('\n')
  const blob = Buffer.from(lines[1] ?? '', 'base64')
  if (blob.length < 10) throw new Error(`${label} is not a minisign blob`)
  return blob
}

const artifacts = process.argv.slice(2)
if (artifacts.length === 0) {
  console.error('usage: verify-update-signature.mjs <artifact>...')
  process.exit(2)
}

const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const pubkey = decodeMinisignBlob(config.plugins?.updater?.pubkey, 'plugins.updater.pubkey')
const algorithm = pubkey.subarray(0, 2).toString()
if (algorithm !== 'Ed') {
  throw new Error(`unsupported public key algorithm: ${algorithm}`)
}
const trustedKeyId = pubkey.subarray(2, 10).toString('hex')
const key = createPublicKey({
  key: Buffer.concat([Buffer.from(SPKI_PREFIX, 'hex'), pubkey.subarray(10)]),
  format: 'der',
  type: 'spki',
})

let failed = false
for (const artifact of artifacts) {
  const label = basename(artifact)
  let signature
  try {
    signature = decodeMinisignBlob(readFileSync(`${artifact}.sig`, 'utf8').trim(), `${label}.sig`)
  } catch (error) {
    console.error(`✗ ${label}: ${error.message}`)
    failed = true
    continue
  }

  const artifactKeyId = signature.subarray(2, 10).toString('hex')
  if (artifactKeyId !== trustedKeyId) {
    console.error(`✗ ${label}: signed by key ${artifactKeyId}, clients trust ${trustedKeyId}`)
    failed = true
    continue
  }
  if (signature.subarray(0, 2).toString() !== 'ED') {
    console.error(`✗ ${label}: unexpected signature algorithm ${signature.subarray(0, 2).toString()}`)
    failed = true
    continue
  }

  // `ED` signatures cover the BLAKE2b-512 digest of the file, not the file.
  const digest = createHash('blake2b512').update(readFileSync(artifact)).digest()
  if (!verify(null, digest, key, signature.subarray(10))) {
    console.error(`✗ ${label}: signature does not match the file`)
    failed = true
    continue
  }
  console.log(`✓ ${label}`)
}

process.exit(failed ? 1 : 0)
