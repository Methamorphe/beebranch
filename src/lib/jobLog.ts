/**
 * GitHub Actions folds each step into a `##[group]<step name>` section of the
 * job log. Return one step's section, or the whole log when the marker is
 * absent (older runners, or a log truncated before that step).
 */
export function sliceJobLog(text: string, step: string | null): string {
  if (!step) {
    return text
  }
  const marker = `##[group]${step}`
  const start = text.indexOf(marker)
  if (start < 0) {
    return text
  }
  const bodyStart = text.indexOf('\n', start)
  if (bodyStart < 0) {
    return ''
  }
  const next = text.indexOf('##[group]', bodyStart)
  const section = next < 0 ? text.slice(bodyStart) : text.slice(bodyStart, next)
  return section.replaceAll('##[endgroup]', '')
}
