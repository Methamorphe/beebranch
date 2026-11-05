/** Preference key for the experimental readability overlay. */
export const VISUAL_PREVIEW_KEY = 'ui.visualPreview'

/** Stable UI versus the opt-in readability preview. */
export type VisualPreview = 'off' | 'readable-beta'

/** Apply or clear `data-visual` so CSS can restyle without replacing dark/light. */
export function applyVisualPreview(preview: VisualPreview) {
  if (preview === 'readable-beta') {
    document.documentElement.dataset.visual = 'readable-beta'
  } else {
    delete document.documentElement.dataset.visual
  }
}

export function parseVisualPreview(raw: string | null | undefined): VisualPreview {
  return raw === 'readable-beta' ? 'readable-beta' : 'off'
}
