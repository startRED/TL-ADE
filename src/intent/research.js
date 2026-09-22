// @ts-check
import { createHash } from 'node:crypto'

const PRODUCER = 'intent-compiler'
const PRODUCER_VERSION = '0.5.0'

/** @param {any} value */
export function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Uma resposta só é suficiente com fonte e ao menos uma afirmação datada.
 *
 * @param {any} result
 * @returns {boolean}
 */
export function isSufficient(result) {
  if (!result || typeof result !== 'object') return false
  if (typeof result.source !== 'string' || result.source.trim() === '') return false
  if (typeof result.date !== 'string' || result.date.trim() === '') return false
  const claims = Array.isArray(result.claims) ? result.claims : []
  return claims.some((/** @type {any} */ c) => {
    if (typeof c === 'string') return c.trim() !== ''
    return c && typeof c.text === 'string' && c.text.trim() !== ''
  })
}

/**
 * Default reversível concreto: o declarado na incógnita, a opção recomendada, ou
 * manter o comportamento atual (sempre reversível, porque nada muda).
 *
 * @param {any} unknown
 * @returns {{ value: any, why: string }}
 */
export function reversibleDefault(unknown) {
  if (unknown.default_if_unknown !== undefined && unknown.default_if_unknown !== null) {
    return { value: unknown.default_if_unknown, why: 'default declarado na incógnita' }
  }
  const recommended = (unknown.options || []).find((/** @type {any} */ o) => o && o.recommended)
  if (recommended?.id) {
    return { value: recommended.id, why: 'opção recomendada da incógnita' }
  }
  return {
    value: 'keep_current_behavior',
    why: 'sem default declarado: manter o comportamento atual do projeto, revertível por não alterar nada',
  }
}

/**
 * Constrói artefato de fallback seguro ou de estacionamento.
 *
 * @param {{ unknown: any, budget?: any, reason: string, fallbackAuthorized?: boolean }} opts
 * @returns {any}
 */
export function fallbackArtifact({ unknown, budget = {}, reason, fallbackAuthorized = true }) {
  const changesContract = unknown.blocks_contract === true
  const canUseFallback = fallbackAuthorized && !changesContract
  const chosen = reversibleDefault(unknown)

  const data = !canUseFallback
    ? {
        fallback_applied: false,
        parked: true,
        reason,
        rationale: `${reason}; sem autorização de fallback dentro do orçamento ou a incógnita altera o contrato, então a story fica estacionada para decisão do operador.`,
      }
    : {
        fallback_applied: true,
        parked: false,
        default_value: chosen.value,
        reversible: true,
        reason,
        rationale: `${reason}; adotado ${chosen.why} até haver evidência externa.`,
      }

  return {
    format_version: 2,
    id: `rf-${unknown.id}`,
    ref: `research-finding:rf-${unknown.id}`,
    kind: 'research_finding',
    digest: digestOf(data),
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    input_digest: digestOf({ unknown, budget }),
    created_at: new Date().toISOString(),
    provenance: ['policy:fallback'],
    confidence: 0.3,
    data,
  }
}

/**
 * Executa uma etapa de pesquisa acionada por external_fact.
 * Sem política, sem pesquisador ou sem resposta suficiente, produz default reversível
 * (ou estacionamento, quando a incógnita muda o contrato ou o fallback não está autorizado).
 *
 * @param {{ unknown: any, budget?: any, researcher?: Function, policy?: any }} input
 * @returns {Promise<any>}
 */
export async function runResearchStep({ unknown, budget = {}, researcher, policy = {} }) {
  if (!unknown || typeof unknown !== 'object' || !unknown.id) {
    throw new TypeError('runResearchStep: incógnita inválida (id obrigatório)')
  }

  const hasBudget =
    budget.max_usd === undefined ||
    (typeof budget.max_usd === 'number' &&
      Number.isFinite(budget.max_usd) &&
      (budget.consumed_usd ?? 0) < budget.max_usd)
  const fallbackAuthorized =
    policy.fallback_authorized !== false &&
    policy.allow_fallback !== false &&
    hasBudget

  if (policy.allow_research === false || typeof researcher !== 'function') {
    const reason =
      policy.allow_research === false
        ? 'Pesquisa desabilitada por política'
        : 'Nenhum pesquisador disponível'
    return fallbackArtifact({ unknown, budget, reason, fallbackAuthorized })
  }

  /** @type {any} */
  let result
  try {
    result = await researcher({ unknown, budget, query: unknown.question, policy })
  } catch (error) {
    return fallbackArtifact({
      unknown,
      budget,
      reason: `Pesquisa falhou: ${error instanceof Error ? error.message : String(error)}`,
      fallbackAuthorized,
    })
  }

  // Se o pesquisador já retornou um envelope de finding formatado (ex: dispatchAgy)
  if (result?.finding && result.finding.kind === 'research_finding') {
    return result.finding
  }

  // Se o pesquisador executou time e retornou resultados de múltiplos participantes
  if (Array.isArray(result?.team_results)) {
    /** @type {any[]} */
    const team = result.team_results
    if (policy.team_enabled !== true || team.length < 2 || team.length > 4) {
      return fallbackArtifact({
        unknown,
        budget,
        reason: 'Resultado de time recebido sem autorização explícita ou fora do limite de 2 a 4 participantes',
        fallbackAuthorized,
      })
    }
    if (team.some((item) => !isSufficient(item))) {
      return fallbackArtifact({
        unknown,
        budget,
        reason: 'Time de pesquisa retornou participante sem fonte, data e afirmação suficientes',
        fallbackAuthorized,
      })
    }
    const confidences = team.map((item) => item.confidence ?? 0.9)
    const answers = team.map((item) => item.answer || item.result || item.claims?.[0]?.text)
    const isEquivalent = Math.max(...confidences) - Math.min(...confidences) <= 0.2
    const isDivergent = new Set(answers.map((answer) => JSON.stringify(answer))).size > 1

    if (isEquivalent && isDivergent) {
      return {
        divergent: true,
        unknown,
        team_results: team,
        question: `Divergência de pesquisa em "${unknown.question}": ${answers.join(' vs ')}`,
        findings: team.map((r, i) => ({
          id: `rf-${unknown.id}-${i + 1}`,
          ref: `research-finding:rf-${unknown.id}-${i + 1}`,
          kind: 'research_finding',
          source: r.source,
          claims: r.claims,
          confidence: r.confidence,
          result: r.answer || r.result,
        })),
      }
    }

    result = team[0]
  }

  if (!isSufficient(result)) {
    return fallbackArtifact({
      unknown,
      budget,
      reason: 'Pesquisa não retornou fonte, data e afirmação suficientes',
      fallbackAuthorized,
    })
  }

  const claims = Array.isArray(result.claims)
    ? result.claims.map((/** @type {any} */ c) => (typeof c === 'string' ? { text: c } : c))
    : []

  const data = {
    source: result.source,
    date: result.date,
    claims,
    confidence: result.confidence ?? 0.9,
    cost: result.cost ?? result.usage?.cost_usd ?? null,
    cost_source: result.cost_source ?? (result.cost !== undefined ? 'reported' : 'unknown'),
    decision: result.decision ?? result.rationale ?? `Decisão factual adotada para ${unknown.id}`,
    result: result.result ?? result.answer ?? 'Resultado suficiente obtido',
    fallback_applied: false,
    parked: false,
  }

  return {
    format_version: 2,
    id: `rf-${unknown.id}`,
    ref: `research-finding:rf-${unknown.id}`,
    kind: 'research_finding',
    digest: digestOf(data),
    producer: result.producer || PRODUCER,
    producer_version: PRODUCER_VERSION,
    input_digest: digestOf({ unknown, budget }),
    created_at: result.date ? `${result.date}T00:00:00.000Z` : new Date().toISOString(),
    provenance: [result.source],
    confidence: data.confidence,
    data,
  }
}
