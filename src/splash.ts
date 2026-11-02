/**
 * Boot splash customization.
 *
 * This script runs in the frameless splash window before the React app exists.
 * It reads the stored `ui.splash` preference through the same IPC command as
 * the settings UI and asks the backend for the image once, so the image and the
 * preference keep a single source of truth in TypeScript.
 *
 * The page starts as `data-splash="pending"`: nothing but the window colour is
 * painted until the mode is known, so a custom splash never flashes the default
 * logo first.
 */

import { invoke } from '@tauri-apps/api/core'
import { LANGUAGE_PREFERENCE_KEY, detectLocale, isLocale, type Locale } from './i18n/locale'
import {
  SPLASH_KEY,
  normalizeMediaOptions,
  parseMediaSettings,
  type MediaSettings,
} from './lib/mediaSettings'

/** The splash renders before the app's catalogue exists; it only needs these. */
const TAGLINES: Record<Locale, string> = {
  fr: 'Préparation de l’espace de travail…',
  en: 'Preparing your workspace…',
}

const STATUS_LABELS: Record<Locale, string> = {
  fr: 'BeeBranch, démarrage en cours',
  en: 'BeeBranch, starting up',
}

/** Total time allowed to resolve the mode before showing the default logo. */
const DEADLINE_MS = 2000
/** The first frames can precede the backend's managed state; retry briefly. */
const PREFERENCE_RETRIES = 6
const PREFERENCE_RETRY_MS = 50

const root = document.documentElement
let settled = false

function settle(mode: 'logo' | 'image') {
  if (settled) {
    return
  }
  settled = true
  root.dataset.splash = mode
}

// `Promise.withResolvers` is ES2024 while the webview target is Safari 13, so
// the timer needs the executor form here.
function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function readPreference(key: string): Promise<string | null> {
  for (let attempt = 0; attempt < PREFERENCE_RETRIES; attempt += 1) {
    try {
      return await invoke<string | null>('preference_get', { key })
    } catch {
      await wait(PREFERENCE_RETRY_MS)
    }
  }
  return null
}

async function applyLanguage() {
  const stored = await readPreference(LANGUAGE_PREFERENCE_KEY)
  const locale: Locale = isLocale(stored) ? stored : detectLocale()
  root.lang = locale
  const status = document.querySelector<HTMLElement>('main.splash')
  if (status) {
    status.setAttribute('aria-label', STATUS_LABELS[locale])
  }
  const tagline = document.querySelector<HTMLElement>('.tagline')
  if (tagline) {
    tagline.textContent = TAGLINES[locale]
  }
}

function apply(settings: MediaSettings, dataUrl: string) {
  const options = normalizeMediaOptions(settings)
  // The image goes straight on the backdrop: Chromium drops custom property
  // values above 2 MiB, which any ordinary photo exceeds (see
  // `lib/background.ts`). The options stay variables so the stylesheet owns the
  // presentation.
  const backdrop = document.querySelector<HTMLElement>('.backdrop')
  if (backdrop) {
    backdrop.style.backgroundImage = `url("${dataUrl}")`
  }
  root.style.setProperty(
    '--splash-size',
    options.fit === 'cover' ? 'cover' : options.fit === 'contain' ? 'contain' : 'auto',
  )
  root.style.setProperty('--splash-repeat', options.fit === 'tile' ? 'repeat' : 'no-repeat')
  root.style.setProperty('--splash-dim', String(options.dim / 100))
  root.style.setProperty('--splash-blur', `${options.blur}px`)
}

async function boot() {
  const deadline = window.setTimeout(() => settle('logo'), DEADLINE_MS)
  try {
    const settings = parseMediaSettings(await readPreference(SPLASH_KEY))
    if (!settings) {
      return
    }
    const dataUrl = await invoke<string>('background_read', { path: settings.path })
    apply(settings, dataUrl)
    settle('image')
  } catch {
    // A moved or unreadable file falls back to the logo: the splash must never
    // block the boot.
  } finally {
    window.clearTimeout(deadline)
    // No-op when the mode already settled; keeps the page out of `pending`
    // when the image read failed.
    settle('logo')
  }
}

void applyLanguage()
void boot()
