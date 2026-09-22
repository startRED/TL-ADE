// @ts-check

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * Remove sequências ANSI de texto.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '')
}

/**
 * Extrai o envelope JSON do stdout do `agy`.
 *
 * @param {string} stdout
 * @returns {{ envelope: Record<string, unknown> | null, error: null | 'empty' | 'not_json' | 'truncated_json' }}
 */
export function parseAgyOutput(stdout) {
  const texto = stripAnsi(stdout).trim()
  if (!texto) {
    return { envelope: null, error: 'empty' }
  }

  const first = texto.indexOf('{')
  const last = texto.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    return { envelope: null, error: 'not_json' }
  }

  try {
    const slice = texto.slice(first, last + 1)
    const parsed = JSON.parse(slice)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { envelope: null, error: 'truncated_json' }
    }
    return { envelope: parsed, error: null }
  } catch {
    return { envelope: null, error: 'truncated_json' }
  }
}

/**
 * Extrai o achado estruturado (finding) de um envelope agy.
 *
 * @param {Record<string, unknown> | null} envelope
 * @returns {{ finding: any | null, valid: boolean, errors: string[] }}
 */
export function parseAgyFinding(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { finding: null, valid: false, errors: ['envelope ausente ou inválido'] }
  }

  let structured = envelope.structured_output

  if (!structured && typeof envelope.response === 'string') {
    const raw = envelope.response
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first !== -1 && last !== -1) {
      try {
        structured = JSON.parse(raw.slice(first, last + 1))
      } catch {
        // ignora
      }
    }
  }

  if (!structured && !envelope.source && !envelope.claims && !envelope.findings) {
    return { finding: null, valid: false, errors: ['resposta do agy sem dados estruturados'] }
  }

  const findingData = /** @type {any} */ (structured || envelope)
  const claims = Array.isArray(findingData.claims) ? findingData.claims : []
  const hasClaim = claims.some((/** @type {any} */ claim) =>
    typeof claim === 'string'
      ? claim.trim() !== ''
      : claim && typeof claim.text === 'string' && claim.text.trim() !== '',
  )
  const errors = []
  if (typeof findingData.source !== 'string' || findingData.source.trim() === '') errors.push('fonte ausente')
  if (typeof findingData.date !== 'string' || findingData.date.trim() === '') errors.push('data ausente')
  if (!hasClaim) errors.push('afirmação ausente')
  if (errors.length > 0) return { finding: null, valid: false, errors }
  return { finding: findingData, valid: true, errors: [] }
}

/**
 * Extrai contadores de tokens e custo do envelope agy sem inventar valores.
 *
 * @param {Record<string, unknown> | null} envelope
 * @param {string} [role='research']
 * @returns {{ cost_usd: number | null, cost_source: 'reported' | 'unknown', cost_basis: string | null, models: Array<{ role: string, model_id: string }>, tokens: any }}
 */
export function parseAgyUsage(envelope, role = 'research') {
  const usage = /** @type {any} */ (envelope?.usage)
  const modelId = typeof envelope?.model === 'string' ? envelope.model : 'gemini-3.8-flash-medium'
  const models = [{ role, model_id: modelId }]

  if (usage && typeof usage === 'object') {
    const totalCost = envelope?.total_cost_usd ?? usage?.total_cost_usd
    const costUsd = typeof totalCost === 'number' && Number.isFinite(totalCost) ? totalCost : null
    const costSource = costUsd !== null ? 'reported' : 'unknown'
    return {
      cost_usd: costUsd,
      cost_source: costSource,
      cost_basis: null,
      models,
      tokens: {
        input: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
        output: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
        cache_read: Number(usage.cache_read_tokens ?? 0),
        cache_write: Number(usage.cache_write_tokens ?? 0),
        usd: costUsd,
        source: costSource,
      },
    }
  }

  return {
    cost_usd: null,
    cost_source: 'unknown',
    cost_basis: null,
    models,
    tokens: { source: 'unavailable' },
  }
}
