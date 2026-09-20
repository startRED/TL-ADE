/**
 * Classifica a complexidade e intenção do pedido.
 *
 * @param {{ request: string, discovery?: any, repoIr?: any }} input
 * @param {Function} [advisor]
 * @returns {Promise<{ complexity: string, confidence: number, source: string, cost: { model_calls: number, usd: number, model_id?: string }, domains?: string[], rationale?: string }>}
 */
export async function classifyIntent(input, advisor) {
  const { request = '', discovery = {} } = input || {}
  const anchors = discovery.anchors || []

  // Critério 1: Correção em um único arquivo descoberto -> trivial determinístico
  const isFix = /corrigir|consertar|ajustar|fix|bug/i.test(request)
  const isSingleAnchor = anchors.length === 1

  if (isFix && isSingleAnchor) {
    return {
      complexity: 'trivial',
      confidence: 0.9,
      source: 'deterministic',
      cost: {
        model_calls: 0,
        usd: 0,
      },
    }
  }

  // Se o advisor for fornecido e não for trivial com alta confiança:
  // Critério 2: No máximo uma chamada injetada é usada
  if (typeof advisor === 'function') {
    const advisorRes = await advisor(input)
    return {
      complexity: advisorRes.complexity || 'feature',
      confidence: advisorRes.confidence ?? 0.85,
      source: 'model',
      cost: advisorRes.cost || {
        usd: 0.015,
        model_calls: 1,
        model_id: 'claude-haiku-4-5',
      },
      domains: advisorRes.domains,
      rationale: advisorRes.rationale,
    }
  }

  // Classificação determinística fallback
  const isLarge = /plataforma|subsistema|arquitetura|distribu[ií]da|sincroniza[çc][ãa]o/i.test(request)
  if (isLarge) {
    return {
      complexity: 'feature',
      confidence: 0.8,
      source: 'deterministic',
      cost: { model_calls: 0, usd: 0 },
    }
  }

  return {
    complexity: isSingleAnchor ? 'bounded' : 'trivial',
    confidence: 0.8,
    source: 'deterministic',
    cost: { model_calls: 0, usd: 0 },
  }
}
