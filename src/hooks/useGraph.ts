import { useCallback, useEffect, useRef, useState } from 'react'
import { graphPage } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { CommitSummary, GraphRow } from '../types/git'

const PAGE_SIZE = 500

type GraphState = {
  commits: CommitSummary[]
  rows: GraphRow[]
  next?: string
  generation: number
  truncated: boolean
}

const EMPTY: GraphState = {
  commits: [],
  rows: [],
  generation: 0,
  truncated: false,
}

type Options = {
  revision?: string
  allRefs?: boolean
}

export function useGraph(
  repoId: string | null,
  generation: number,
  options: Options = {},
) {
  const [state, setState] = useState<GraphState>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextRef = useRef<string | undefined>(undefined)
  const loadingRef = useRef(false)
  const requestRef = useRef(0)
  const revision = options.revision
  const allRefs = options.allRefs ?? false
  const context = `${repoId ?? ''}|${revision ?? ''}|${allRefs ? 'all' : 'head'}`
  const contextRef = useRef(context)

  const load = useCallback(
    async (after?: string) => {
      if (!repoId || loadingRef.current) {
        return
      }
      const request = ++requestRef.current
      loadingRef.current = true
      setLoading(true)
      setError(null)

      try {
        const page = await graphPage(
          repoId,
          { after, limit: PAGE_SIZE },
          revision,
          allRefs,
        )
        if (request !== requestRef.current) {
          return
        }
        const fresh = after === undefined
        setState((current) => ({
          commits: fresh ? page.commits : [...current.commits, ...page.commits],
          rows: fresh ? page.rows : [...current.rows, ...page.rows],
          next: page.next,
          generation: page.generation,
          truncated: page.truncated,
        }))
        nextRef.current = page.next
      } catch (cause) {
        if (request === requestRef.current) {
          setError(errorMessage(cause))
        }
      } finally {
        if (request === requestRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [repoId, revision, allRefs],
  )

  useEffect(() => {
    const switched = contextRef.current !== context
    contextRef.current = context
    requestRef.current += 1
    nextRef.current = undefined
    loadingRef.current = false
    // A refresh of the same repository keeps the previous page on screen:
    // replacing it with an empty list made the graph blink on every fetch.
    if (switched) {
      setState(EMPTY)
    }
    if (repoId) {
      void load(undefined)
    }
  }, [context, repoId, generation, load])

  const loadMore = useCallback(() => {
    if (nextRef.current && !loadingRef.current) {
      void load(nextRef.current)
    }
  }, [load])

  return {
    commits: state.commits,
    rows: state.rows,
    next: state.next,
    truncated: state.truncated,
    loading,
    error,
    loadMore,
    reload: () => void load(undefined),
  }
}
