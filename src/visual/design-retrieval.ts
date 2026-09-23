import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_CATALOG_PATH = new URL('../../fixtures/visual/design-catalog.json', import.meta.url)

/**
 * Tokeniza texto simples para cálculo de BM25.
 */
function tokenize(text: string): string[] {
  if (!text || typeof text !== 'string') return []
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 1)
}

/**
 * Calcula pontuação BM25 de um documento contra uma lista de termos de busca.
 */
function bm25Score(queryTokens: string[], docTokens: string[], avgDocLen: number, k1: number = 1.2, b: number = 0.75): number {
  if (docTokens.length === 0 || queryTokens.length === 0) return 0
  const docLen = docTokens.length
  const tfMap = new Map()
  for (const t of docTokens) {
    tfMap.set(t, (tfMap.get(t) || 0) + 1)
  }

  let score = 0
  for (const q of queryTokens) {
    const tf = tfMap.get(q) || 0
    if (tf > 0) {
      const num = tf * (k1 + 1)
      const den = tf + k1 * (1 - b + b * (docLen / (avgDocLen || 1)))
      score += num / den
    }
  }
  return score
}

/**
 * Carrega o catálogo de design local.
 */
export function loadDesignCatalog(providedCatalog: any): any {
  if (providedCatalog && typeof providedCatalog === 'object') {
    return providedCatalog
  }
  try {
    const raw = fs.readFileSync(fileURLToPath(DEFAULT_CATALOG_PATH), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {
      macrostructures: [],
      components: [],
      palettes: [],
      guidance: {
        heroGuidance: 'hero cabe em 1280x800/100svh',
        spacingGuidance: '80-160 px entre seções',
      },
    }
  }
}

/**
 * Recomenda referências locais de design via BM25 para alimentar Maker e Juiz como evidência.
 */
export function recommendDesign({ brief, catalog, limit = 3 }: {
        brief: any
        catalog?: any
        limit?: number
    }): {
    macrostructure: any
    examples: any[]
    components: any[]
    palette: any
    evidence: { query: string; score: number; catalog_entries_evaluated: number }
    heroGuidance: string
    spacingGuidance: string
} {
  const cat = loadDesignCatalog(catalog)
  const mode = brief?.surface_mode || 'persuade'
  const queryText = [
    mode,
    brief?.audience || '',
    brief?.direction?.name || '',
    brief?.direction?.signature || '',
    ...(brief?.preserved_patterns || []),
  ].join(' ')

  const queryTokens = tokenize(queryText)

  // 1. Avalia macroestruturas com BM25
  const macrostructures = ((cat.macrostructures || []) as any[])
  let bestMacro = null
  let bestMacroScore = -1

  const allMacroTokens = macrostructures.map((m) =>
    tokenize(`${m.name} ${m.description} ${(m.keywords || []).join(' ')} ${m.surface_mode}`),
  )
  const avgMacroLen =
    allMacroTokens.reduce((acc, t) => acc + t.length, 0) / (allMacroTokens.length || 1)

  for (let i = 0; i < macrostructures.length; i++) {
    const m = macrostructures[i]
    let score = bm25Score(queryTokens, allMacroTokens[i], avgMacroLen)
    if (m.surface_mode === mode) {
      score += 2.0 // Boost por alinhamento de modo de superfície
    }
    if (score > bestMacroScore) {
      bestMacroScore = score
      bestMacro = m
    }
  }

  // 2. Avalia componentes com BM25 (limite <= 3)
  const components = ((cat.components || []) as any[])
  const allCompTokens = components.map((c) =>
    tokenize(`${c.name} ${c.description} ${(c.keywords || []).join(' ')} ${c.surface_mode}`),
  )
  const avgCompLen =
    allCompTokens.reduce((acc, t) => acc + t.length, 0) / (allCompTokens.length || 1)

  const rankedComponents = components
    .map((c, i) => {
      let score = bm25Score(queryTokens, allCompTokens[i], avgCompLen)
      if (c.surface_mode === mode) score += 1.5
      return { comp: c, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 3))
    .map((r) => r.comp)

  // 3. Avalia paleta
  const palettes = ((cat.palettes || []) as any[])
  const bestPalette =
    palettes.find((p) => p.surface_mode === mode) ||
    palettes[0] ||
    brief?.tokens?.palette || { dominant: '#0f172a', accent: '#6366f1' }

  return {
    macrostructure: bestMacro || macrostructures[0] || null,
    examples: [
      {
        id: `example-${mode}`,
        title: `Padrão de referência para ${mode}`,
        surface_mode: mode,
        source: 'local-catalog',
      },
    ],
    components: rankedComponents,
    palette: bestPalette,
    evidence: {
      query: queryText.slice(0, 100),
      score: Math.round(bestMacroScore * 100) / 100,
      catalog_entries_evaluated: macrostructures.length + components.length,
    },
    heroGuidance: cat.guidance?.heroGuidance || 'hero cabe em 1280x800/100svh',
    spacingGuidance: cat.guidance?.spacingGuidance || '80-160 px entre seções',
  }
}

/**
 * Compara dois candidatos de design contra o briefing.
 */
export function compareDesign({ candidateA, candidateB, brief }: {
        candidateA: any
        candidateB: any
        brief: any
    }): {
    winner: 'A' | 'B' | 'tie'
    scoreA: number
    scoreB: number
    rationale: string
} {
  const mode = brief?.surface_mode || 'persuade'
  let scoreA = 0
  let scoreB = 0

  if (candidateA?.surface_mode === mode) scoreA += 2
  if (candidateB?.surface_mode === mode) scoreB += 2

  if (candidateA?.density === brief?.character?.density) scoreA += 1
  if (candidateB?.density === brief?.character?.density) scoreB += 1

  const winner = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'tie'
  const rationale = `Comparação contra modo ${mode}: candidato A pontuou ${scoreA}, candidato B pontuou ${scoreB}. Vencedor: ${winner}.`

  return {
    winner,
    scoreA,
    scoreB,
    rationale,
  }
}
