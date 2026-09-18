// @ts-check

/**
 * @typedef {{
 *   status: string,
 *   reason: string | null,
 *   commit: string | null,
 * }} UnitState
 *
 * @typedef {{
 *   unit: string,
 *   status: string,
 *   reason: string | null,
 *   commit: string | null,
 * }} ProjectedUnit
 */

/**
 * Normaliza um valor para string ou null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeStringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/**
 * Projeta o estado das unidades a partir dos eventos do diário.
 *
 * @param {ReadonlyArray<Record<string, any>>} events
 * @returns {Array<ProjectedUnit>}
 */
export function projectUnits(events) {
  /** @type {Map<string, UnitState>} */
  const map = new Map()

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const rawUnit = ev.data?.unit ?? ev.unit
    if (typeof rawUnit !== 'string') continue

    if (ev.kind === 'story_started') {
      if (!map.has(rawUnit)) {
        map.set(rawUnit, {
          status: 'in_progress',
          reason: null,
          commit: null,
        })
      }
    } else if (ev.kind === 'story_done') {
      const data = ev.data ?? {}
      map.set(rawUnit, {
        status: String(data.status),
        reason: normalizeStringOrNull(data.reason),
        commit: normalizeStringOrNull(data.commit),
      })
    }
  }

  return [...map].map(([unit, v]) => ({ unit, ...v }))
}

