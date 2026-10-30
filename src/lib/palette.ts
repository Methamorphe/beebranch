/**
 * Command palette ranking.
 *
 * Ordering: available commands first, then the best textual match, then the
 * most recent ones (so an empty query opens on what was just used), then the
 * commands relevant to the active view, then alphabetical.
 */

export type RankableCommand = {
  id: string
  label: string
  available?: boolean
  contextual?: boolean
}

/** Direct substring first, then a subsequence match scored by its gaps. */
export function paletteScore(query: string, label: string): number | null {
  if (!query) {
    return 0
  }
  const haystack = label.toLowerCase()
  const needle = query.toLowerCase()
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    return direct
  }
  let index = 0
  let gaps = 0
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1
      if (index === needle.length) {
        return 100 + gaps
      }
    } else if (index > 0) {
      gaps += 1
    }
  }
  return null
}

export function rankCommands<T extends RankableCommand>(
  commands: T[],
  query: string,
  recent: string[] = [],
): T[] {
  const rank = new Map(recent.map((id, position) => [id, position]))
  const notRecent = recent.length
  return commands
    .map((command) => ({ command, score: paletteScore(query.trim(), command.label) }))
    .filter(
      (entry): entry is { command: T; score: number } => entry.score !== null,
    )
    .sort(
      (a, b) =>
        Number(a.command.available === false) -
          Number(b.command.available === false) ||
        a.score - b.score ||
        (rank.get(a.command.id) ?? notRecent) -
          (rank.get(b.command.id) ?? notRecent) ||
        Number(b.command.contextual === true) -
          Number(a.command.contextual === true) ||
        a.command.label.localeCompare(b.command.label),
    )
    .map((entry) => entry.command)
}
