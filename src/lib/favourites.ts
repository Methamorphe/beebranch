/**
 * Favourite repositories, backed by one preference value.
 *
 * Slots are positions, not identities: reordering moves a favourite, removing
 * one shifts the rest, and a path that no longer exists keeps its slot until
 * the user removes it — opening it reports the missing repository instead.
 */

export type Favourite = {
  path: string
  name: string
}

export const FAVOURITE_SLOTS = 9

export function parseFavourites(raw: string | null): Favourite[] {
  if (!raw) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const list: Favourite[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !('path' in entry)) {
      continue
    }
    const path = entry.path
    if (typeof path !== 'string' || path.length === 0) {
      continue
    }
    if (list.some((item) => item.path === path)) {
      continue
    }
    const storedName = 'name' in entry ? entry.name : undefined
    const name =
      typeof storedName === 'string' && storedName.length > 0
        ? storedName
        : path.split(/[\\/]/).filter(Boolean).pop() ?? path
    list.push({ path, name })
    if (list.length === FAVOURITE_SLOTS) {
      break
    }
  }
  return list
}

export function serializeFavourites(list: Favourite[]): string {
  return JSON.stringify(list.slice(0, FAVOURITE_SLOTS))
}

export function toggleFavourite(list: Favourite[], entry: Favourite): Favourite[] {
  if (list.some((item) => item.path === entry.path)) {
    return list.filter((item) => item.path !== entry.path)
  }
  return [...list, entry].slice(0, FAVOURITE_SLOTS)
}

/** Swap a favourite with its neighbour; out-of-range moves change nothing. */
export function moveFavourite(
  list: Favourite[],
  path: string,
  direction: -1 | 1,
): Favourite[] {
  const index = list.findIndex((item) => item.path === path)
  const target = index + direction
  if (index < 0 || target < 0 || target >= list.length) {
    return list
  }
  const next = [...list]
  const moved = next[index]!
  next[index] = next[target]!
  next[target] = moved
  return next
}
