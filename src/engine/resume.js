// @ts-check

/**
 * Encontra o último evento story_started para a unidade especificada.
 *
 * @param {Array<Record<string, any>>} events Lista de eventos do journal.
 * @param {string} unit Identificador da story/unidade.
 * @returns {{ worktree_dir: string, tree_before: string } | null}
 */
export function findStoryStarted(events, unit) {
  if (!Array.isArray(events)) {
    return null
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.kind === 'story_started') {
      const eventUnit = ev.data?.unit ?? ev.unit
      if (
        eventUnit === unit &&
        ev.data &&
        typeof ev.data.worktree_dir === 'string' &&
        typeof ev.data.tree_before === 'string'
      ) {
        return {
          worktree_dir: ev.data.worktree_dir,
          tree_before: ev.data.tree_before,
        }
      }
    }
  }
  return null
}
