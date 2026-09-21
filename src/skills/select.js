// @ts-check
import { rankSkills } from './bm25.js'

/**
 * Seleciona habilidades para o contexto de uma história aplicando o pipeline Skill Fabric:
 * (0) Filtro duro (domínio, linguagem, família, licença, quarentena)
 * (1) Ranqueamento BM25 (top-8)
 * (2) Seletor (injetável ou fallback determinístico)
 * (3) Fecho determinístico sob os tetos (<= 3 skills, <= 7.5k tokens/skill, <= 20k tokens total).
 *
 * @param {{
 *   story: { id?: string, task?: string, domain?: string, domains?: string[], language?: string, languages?: string[], family?: string, maker_family?: string, [key: string]: any },
 *   candidates: Array<any>,
 *   selector?: (args: { story: any, candidates: any[] }) => Promise<any[]> | any[],
 *   budget?: { maxSkills?: number, maxTokensPerSkill?: number, maxTotalTokens?: number },
 * }} options
 * @returns {Array<{ id: string, name?: string, score: number, source: string, sha256: string, bodyTokens: number, references: string[], [key: string]: any }>}
 */
export function selectStorySkills({ story = {}, candidates = [], selector, budget = {} }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return []
  }

  const storyDomains = (story.domains || (story.domain ? [story.domain] : [])).map((/** @type {any} */ d) => String(d).toLowerCase())
  const storyLanguages = (story.languages || (story.language ? [story.language] : [])).map((/** @type {any} */ l) =>
    String(l).toLowerCase(),
  )
  const makerFamily = (story.maker_family || story.family || '').toLowerCase()

  // (0) Filtro duro
  const filtered = candidates.filter((cand) => {
    if (!cand || typeof cand !== 'object' || !cand.id) {
      return false
    }

    // Quarentena é excluída de seleção
    if (cand.trust === 'quarantine') {
      return false
    }

    // Licenças bloqueadas
    if (cand.license && typeof cand.license === 'string') {
      const lic = cand.license.toLowerCase()
      if (lic === 'proprietary' || lic === 'commercial') {
        return false
      }
    }

    // Domínios
    const candDomains = (cand.domains || (cand.domain ? [cand.domain] : [])).map((/** @type {any} */ d) => String(d).toLowerCase())
    if (storyDomains.length > 0 && candDomains.length > 0) {
      const hasDomainMatch = candDomains.some((/** @type {string} */ d) => storyDomains.includes(d))
      if (!hasDomainMatch) {
        return false
      }
    }

    // Linguagens
    const candLanguages = (cand.languages || (cand.language ? [cand.language] : [])).map((/** @type {any} */ l) =>
      String(l).toLowerCase(),
    )
    if (storyLanguages.length > 0 && candLanguages.length > 0) {
      const hasLangMatch = candLanguages.some((/** @type {string} */ l) => storyLanguages.includes(l))
      if (!hasLangMatch) {
        return false
      }
    }

    // Famílias
    const candFamilies = (cand.families || []).map((/** @type {any} */ f) => String(f).toLowerCase())
    if (makerFamily && candFamilies.length > 0) {
      if (!candFamilies.includes(makerFamily)) {
        return false
      }
    }

    return true
  })

  if (filtered.length === 0) {
    return []
  }

  // (1) BM25 top-8
  const topK = 8
  const rankedTop8 = rankSkills({
    story,
    entries: filtered,
    topK,
  })

  // (2) Seletor (com fallback BM25)
  let candidatePool = rankedTop8
  if (typeof selector === 'function') {
    try {
      const chosen = selector({ story, candidates: rankedTop8 })
      if (Array.isArray(chosen)) {
        candidatePool = chosen
      }
    } catch {
      // fallback determinístico
      candidatePool = rankedTop8
    }
  }

  // (3) Fecho sob tetos
  const maxSkills = budget.maxSkills ?? 3
  const maxTokensPerSkill = budget.maxTokensPerSkill ?? 7500
  const maxTotalTokens = budget.maxTotalTokens ?? 20000

  // Ordenação determinística: score desc, desempate por id asc
  const sorted = [...candidatePool].sort((a, b) => {
    const scoreA = a.score ?? 0
    const scoreB = b.score ?? 0
    if (scoreB !== scoreA) {
      return scoreB - scoreA
    }
    const idA = a.id || a.entry?.id || ''
    const idB = b.id || b.entry?.id || ''
    return idA.localeCompare(idB)
  })

  const selected = []
  let currentTotalTokens = 0

  for (const item of sorted) {
    if (selected.length >= maxSkills) break

    const cand = item.entry || item
    const tokens = cand.body_tokens ?? cand.bodyTokens ?? 0

    if (tokens > maxTokensPerSkill) continue
    if (currentTotalTokens + tokens > maxTotalTokens) continue

    selected.push({
      id: cand.id,
      name: cand.name || cand.id,
      score: item.score ?? 0,
      source: cand.source || '',
      sha256: cand.sha256 || '',
      bodyTokens: tokens,
      references: cand.references || [],
      license: cand.license,
      content: cand.content,
      bytes: cand.bytes,
    })

    currentTotalTokens += tokens
  }

  return selected
}
