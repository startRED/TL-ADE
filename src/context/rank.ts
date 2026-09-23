/**
 * Custo determinístico estimado, em tokens, de um candidato do contexto.
 */
function estimateCost(item: any): number {
  return Math.max(12, Math.ceil(JSON.stringify(item).length / 6))
}

/**
 * Ranqueia símbolos e relações do IR de acordo com relevância e orçamento de tokens.
 */
export function rankRepoContext({
  ir,
  query = '',
  touchedPaths = [],
  riskSurfaces = [],
  maxTokens = 500,
}: {
        ir: any
        query?: string
        touchedPaths?: string[]
        riskSurfaces?: string[]
        maxTokens?: number
    }): {
    items: any[]
    estimated_tokens: number
    revision: string
} {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new TypeError('maxTokens deve ser um número finito não negativo')
  }

  
  const symbols: any[] = ir?.data?.symbols || []
  
  const relations: any[] = ir?.data?.relations || []
  const revision = ir?.revision || ir?.data?.tree_state?.revision || 'unknown'

  const queryLower = query.toLowerCase()
  const touchedLower = touchedPaths.map((p) => p.toLowerCase())
  const risksLower = riskSurfaces.map((r) => r.toLowerCase())

  const score = (haystacks: string[], pathLower: string): number => {
    let s = 0
    if (pathLower && touchedLower.includes(pathLower)) {
      s += 100
    }
    if (queryLower && haystacks.some((h) => h.includes(queryLower))) {
      s += 50
    }
    if (risksLower.some((r) => [...haystacks, pathLower].some((h) => h && h.includes(r)))) {
      s += 30
    }
    return s
  }

  const candidates = [
    ...symbols.map((s: any) => {
      const pathLower = (s.path || '').toLowerCase()
      return {
        item: { ...s, ref: s.ref || `repo:symbol:${s.name}` },
        score: score([(s.name || '').toLowerCase()], pathLower),
        // Símbolo antes da relação em empate: relação depende dos símbolos que liga.
        tie: 0,
      }
    }),
    ...relations.map((r: any) => ({
      item: { ...r, ref: r.ref || `repo:rel:${r.from}->${r.to}` },
      score: score([(r.from || '').toLowerCase(), (r.to || '').toLowerCase()], (r.path || '').toLowerCase()),
      tie: 1,
    })),
  ]

  candidates.sort((a, b) => b.score - a.score || a.tie - b.tie)

  const items = []
  let estimated_tokens = 0

  for (const { item } of candidates) {
    const cost = estimateCost(item)
    if (estimated_tokens + cost > maxTokens) {
      continue
    }
    items.push(item)
    estimated_tokens += cost
  }

  return {
    items,
    estimated_tokens,
    revision,
  }
}
