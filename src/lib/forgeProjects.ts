type NamedProject = {
  name: string
  pathWithNamespace: string
}

/** Parent path: a GitLab group, or a GitHub organisation or user. */
export function projectGroup(pathWithNamespace: string): string {
  const index = pathWithNamespace.lastIndexOf('/')
  return index > 0 ? pathWithNamespace.slice(0, index) : ''
}

export function groupProjects<T extends NamedProject>(projects: T[]): { key: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const project of projects) {
    const key = projectGroup(project.pathWithNamespace)
    const list = groups.get(key)
    if (list) list.push(project)
    else groups.set(key, [project])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(([key, items]) => ({
      key,
      items: [...items].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    }))
}
