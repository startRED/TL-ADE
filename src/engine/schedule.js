// @ts-check
import { AdeError } from '../journal/errors.js'

/**
 * Valida se um estado indica que a story foi concluída.
 *
 * @param {any} state
 * @returns {boolean}
 */
function isCompleted(state) {
  if (!state) return false
  if (state === 'completed' || state === 'done') return true
  if (typeof state === 'object') {
    return state.status === 'completed' || state.state === 'completed' || state.outcome === 'completed'
  }
  return false
}

/**
 * Valida o grafo de dependências das stories:
 * - Valida unicidade de id
 * - Valida existência das dependências declaradas em depends_on
 * - Detecta ciclos no grafo
 * Lança AdeError com exitCode 2 em caso de violação de integridade.
 *
 * @param {Array<{ id: string, depends_on?: string[] }>} stories
 * @returns {void}
 */
export function validateGraph(stories) {
  if (!Array.isArray(stories)) {
    throw new AdeError('invalid_stories_graph', 'stories deve ser um array', 2)
  }

  const ids = new Set()
  for (const story of stories) {
    if (!story || typeof story.id !== 'string' || story.id.length === 0) {
      throw new AdeError('invalid_story_id', 'story com id inválido ou ausente', 2)
    }
    if (ids.has(story.id)) {
      throw new AdeError('duplicate_story_id', `id de story duplicado: ${story.id}`, 2, { id: story.id })
    }
    ids.add(story.id)
  }

  // Valida existência de depends_on
  for (const story of stories) {
    const deps = story.depends_on ?? []
    if (!Array.isArray(deps)) {
      throw new AdeError('invalid_depends_on', `depends_on inválido na story ${story.id}`, 2)
    }
    for (const dep of deps) {
      if (!ids.has(dep)) {
        throw new AdeError('missing_dependency', `dependência ausente: ${dep}`, 2, { storyId: story.id, missing: dep })
      }
    }
  }

  // Detecção de ciclos via DFS
  // 0: não visitado, 1: visitando (na pilha), 2: visitado (concluído)
  const stateMap = new Map()
  for (const id of ids) {
    stateMap.set(id, 0)
  }

  const storyMap = new Map()
  for (const story of stories) {
    storyMap.set(story.id, story.depends_on ?? [])
  }

  /**
   * @param {string} node
   */
  function dfs(node) {
    stateMap.set(node, 1)
    const deps = storyMap.get(node) || []
    for (const dep of deps) {
      const depState = stateMap.get(dep)
      if (depState === 1) {
        throw new AdeError('cycle_detected', `ciclo de dependências detectado envolvendo: ${node} -> ${dep}`, 2, {
          from: node,
          to: dep,
        })
      }
      if (depState === 0) {
        dfs(dep)
      }
    }
    stateMap.set(node, 2)
  }

  for (const id of ids) {
    if (stateMap.get(id) === 0) {
      dfs(id)
    }
  }
}

/**
 * Seleciona a próxima story pronta para execução respeitando a ordem de dependências e desempate por id.
 *
 * @param {Array<{ id: string, depends_on?: string[] }>} stories
 * @param {Record<string, any>} [states]
 * @returns {{ id: string } | null}
 */
export function nextReady(stories, states = {}) {
  validateGraph(stories)

  const candidates = []
  for (const story of stories) {
    // Se a story já está concluída, não precisa rodar de novo
    if (isCompleted(states[story.id])) {
      continue
    }

    const deps = story.depends_on ?? []
    const allDepsCompleted = deps.every((dep) => isCompleted(states[dep]))
    if (allDepsCompleted) {
      candidates.push(story)
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // Ordena candidatos por id
  candidates.sort((a, b) => a.id.localeCompare(b.id))

  return { id: candidates[0].id }
}
