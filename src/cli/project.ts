type UnitState = {
    status: string
    reason: string | null
    commit: string | null
}

type ProjectedUnit = {
    unit: string
    status: string
    reason: string | null
    commit: string | null
}

/**
 * Normaliza um valor para string ou null.
 */
function normalizeStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Projeta o estado das unidades a partir dos eventos do diário.
 */
export function projectUnits(events: ReadonlyArray<Record<string, any>>): Array<ProjectedUnit> {
  
  const map: Map<string, UnitState> = new Map()

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

