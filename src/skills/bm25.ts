/**
 * Tokeniza texto por caracteres não-palavra (\W+) com case-folding.
 */
export function tokenize(text?: string): string[] {
  if (!text) return []
  return String(text)
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean)
}

/**
 * Ranqueia habilidades do catálogo usando BM25 ponderado por campos.
 * Campos: name (3.0), tags (2.0), when_to_use (2.0), description (1.0).
 */
export function rankSkills({ story = {}, entries = [], topK = 8 }: {
        story: { task?: string; request?: string; description?: string; id?: string; domains?: string[]; languages?: string[] }
        entries: Array<{ id: string; name?: string; tags?: string[]; when_to_use?: string; description?: string;[key: string]: any }>
        topK?: number
    }): Array<{ id: string; score: number; entry?: any }> {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const k1 = 1.2
  const b = 0.75
  const weights = {
    name: 3.0,
    tags: 2.0,
    when_to_use: 2.0,
    description: 1.0,
  }

  // Tokens da query: derivados da tarefa/pedido da história (não dos domínios, que são filtro duro)
  const queryText = [story.task, story.request, story.description].filter(Boolean).join(' ')
  const queryTokens = [...new Set(tokenize(queryText))]

  if (queryTokens.length === 0) {
    return entries.slice(0, topK).map((e) => ({ id: e.id, score: 0, entry: e }))
  }

  const docs = entries.map((e) => ({
    entry: e,
    fields: {
      name: tokenize(e.name || e.id),
      tags: (e.tags || []).flatMap((t) => tokenize(t)),
      when_to_use: tokenize(e.when_to_use),
      description: tokenize(e.description),
    },
  }))

  const N = docs.length

  // Frequência de documento (DF) por termo de busca
  
  const df: Record<string, number> = {}
  for (const term of queryTokens) {
    let count = 0
    for (const doc of docs) {
      if (
        doc.fields.name.includes(term) ||
        doc.fields.tags.includes(term) ||
        doc.fields.when_to_use.includes(term) ||
        doc.fields.description.includes(term)
      ) {
        count++
      }
    }
    df[term] = count
  }

  // Comprimento médio por campo
  
  const avglen: Record<string, number> = {}
  for (const field of (Object.keys(weights) as Array<keyof typeof weights>)) {
    const total = docs.reduce((acc, d) => acc + d.fields[field].length, 0)
    avglen[field] = total / N || 1
  }

  const scored = docs.map((doc) => {
    let score = 0
    for (const term of queryTokens) {
      const n = df[term] || 0
      if (n === 0) continue

      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))

      for (const [field, w] of (Object.entries(weights) as Array<[keyof typeof weights, number]>)) {
        const toks = doc.fields[field]
        const tf = toks.filter((t) => t === term).length
        if (tf === 0) continue

        const len = toks.length
        const avg = avglen[field]
        const termScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avg)))
        score += w * idf * termScore
      }
    }
    return {
      id: doc.entry.id,
      score,
      entry: doc.entry,
    }
  })

  // Ordenação determinística: score desc, desempate por id asc
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.id.localeCompare(b.id)
  })

  return scored.slice(0, topK)
}
