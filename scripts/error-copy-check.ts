/**
 * Headless checks for the error catalogue.
 * Run: npx tsx scripts/error-copy-check.ts
 */
import assert from 'node:assert/strict'
import { errorCopy } from '../src/i18n/errors/index.ts'
import en from '../src/i18n/errors/en.ts'
import fr from '../src/i18n/errors/fr.ts'
import { setLocale, type Locale } from '../src/i18n/translate.ts'
import type { AppError } from '../src/types/git.ts'

function sample(code: string, params?: Record<string, string>): AppError {
  return {
    code,
    category: 'internal',
    message: 'phrase backend',
    retryable: false,
    params,
  }
}

function rendered(locale: Locale, error: AppError): string {
  setLocale(locale)
  const copy = errorCopy(error)
  return `${copy.message}\n${copy.remediation ?? ''}`
}

for (const locale of ['fr', 'en'] as const) {
  const timeout = rendered(locale, sample('git.timeout', { seconds: '12.0' }))
  assert.ok(timeout.includes('12.0'), timeout)
  assert.ok(!timeout.includes('{'), timeout)

  const credential = rendered(locale, sample('gitlab.git_credential_rejected', { source: 'osxkeychain' }))
  assert.ok(credential.includes('osxkeychain'), credential)
  assert.ok(!credential.includes('{'), credential)

  const push = rendered(locale, sample('git.non_fast_forward'))
  assert.ok(!push.includes('fast-forward'), push)
  assert.ok(!push.includes('{'), push)

  const unknown = rendered(locale, sample('git.exit_unknown', { code: '128' }))
  assert.ok(!unknown.includes('{'), unknown)
  assert.ok(!unknown.includes('128'), unknown)

  const network = rendered(locale, sample('network.unreachable'))
  assert.ok(!network.includes('{'), network)
}

const catalogs = [
  ['fr', fr],
  ['en', en],
] as const
for (const [locale, catalog] of catalogs) {
  for (const [code, entry] of Object.entries(catalog)) {
    const names = [...`${entry.message} ${entry.remediation ?? ''}`.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
    const params = Object.fromEntries(names.map((name) => [name, 'valeur']))
    const text = rendered(locale, sample(code, params))
    assert.ok(!text.includes('{'), `${locale} ${code}: ${text}`)
    for (const name of names) {
      assert.ok(text.includes('valeur'), `${locale} ${code} missing ${name}`)
    }
  }
}

const fallback = rendered('en', sample('not.a.real.code'))
assert.equal(fallback, 'phrase backend\n')
