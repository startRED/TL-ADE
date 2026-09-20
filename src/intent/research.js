import { createHash } from 'node:crypto'

const PRODUCER = 'intent-compiler'
const PRODUCER_VERSION = '0.3.0'

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Uma resposta só é suficiente com fonte e ao menos uma afirmação datada. */
function isSufficient(result) {
  if (!result || typeof result !== 'object') return false
  if (typeof result.source !== 'string' || result.source.trim() === '') return false
  if (typeof result.date !== 'string' || result.date.trim() === '') return false
  const claims = Array.isArray(result.claims) ? result.claims : []
  return claims.some((c) => c && typeof c.text === 'string' && c.text.trim() !== '')
}

/**
 * Default reversível concreto: o declarado na incógnita, a opção recomendada, ou
 * manter o comportamento atual (sempre reversível, porque nada muda).
 */
function reversibleDefault(unknown) {
  if (unknown.default_if_unknown !== undefined && unknown.default_if_unknown !== null) {
    return { value: unknown.default_if_unknown, why: 'default declarado na incógnita' }
  }
  const recommended = (unknown.options || []).find((o) => o && o.recommended)
  if (recommended?.id) {
    return { value: recommended.id, why: 'opção recomendada da incógnita' }
  }
  return {
    value: 'keep_current_behavior',
    why: 'sem default declarado: manter o comportamento atual do projeto, revertível por não alterar nada',
  }
}

function fallbackArtifact({ unknown, budget, reason }) {
  const changesContract = unknown.blocks_contract === true
  const chosen = changesContract ? null : reversibleDefault(unknown)
  const data = changesContract
    ? {
        fallback_applied: true,
        parked: true,
        rationale: `${reason}; a incógnita altera o contrato, então a story fica estacionada para decisão do operador.`,
      }
    : {
        fallback_applied: true,
        parked: false,
        default_value: chosen.value,
        reversible: true,
        rationale: `${reason}; adotado ${chosen.why} até haver evidência externa.`,
      }

  return {
    format_version: 2,
    id: `rf-${unknown.id}`,
    ref: `research-finding:${unknown.id}`,
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
 * Executa uma única etapa opcional de pesquisa acionada por external_fact.
 * Sem política, sem pesquisador ou sem resposta suficiente, produz default reversível
 * (ou estacionamento, quando a incógnita muda o contrato).
 *
 * @param {{ unknown: any, budget?: any, researcher?: Function, policy?: any }} input
 * @returns {Promise<any>}
 */
export async function runResearchStep({ unknown, budget = {}, researcher, policy = {} }) {
  if (!unknown || typeof unknown !== 'object' || !unknown.id) {
    throw new TypeError('runResearchStep: incógnita inválida (id obrigatório)')
  }

  if (policy.allow_research === false || typeof researcher !== 'function') {
    const reason =
      policy.allow_research === false
        ? 'Pesquisa desabilitada por política'
        : 'Nenhum pesquisador disponível'
    return fallbackArtifact({ unknown, budget, reason })
  }

  let result
  try {
    result = await researcher({ unknown, budget, query: unknown.question })
  } catch (error) {
    // Falha controlada do pesquisador cai no mesmo caminho da ausência de resposta.
    return fallbackArtifact({ unknown, budget, reason: `Pesquisa falhou: ${error.message}` })
  }

  if (!isSufficient(result)) {
    return fallbackArtifact({ unknown, budget, reason: 'Pesquisa não retornou fonte, data e afirmação suficientes' })
  }

  const data = { ...result, fallback_applied: false, parked: false }

  return {
    format_version: 2,
    id: `rf-${unknown.id}`,
    ref: `research-finding:${unknown.id}`,
    kind: 'research_finding',
    digest: digestOf(data),
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    input_digest: digestOf({ unknown, budget }),
    created_at: `${result.date}T00:00:00.000Z`,
    provenance: [result.source],
    confidence: 0.9,
    data,
  }
}
