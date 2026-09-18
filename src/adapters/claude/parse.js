import { validate } from '../../schema/index.js'

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * Remove sequências de escape ANSI (CSI) de um texto.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}

/**
 * Extrai o envelope JSON de um stdout bruto do `claude`, tolerando ruído ANSI ao redor.
 *
 * @param {string} stdout
 * @returns {{ envelope: Record<string, unknown> | null, error: null | 'empty' | 'not_json' | 'truncated_json' }}
 */
export function parseClaudeOutput(stdout) {
  const texto = stripAnsi(stdout).trim()

  if (texto === '') {
    return { envelope: null, error: 'empty' }
  }

  const first = texto.indexOf('{')
  if (first === -1) {
    return { envelope: null, error: 'not_json' }
  }

  const last = texto.lastIndexOf('}')
  const slice = texto.slice(first, last + 1)

  try {
    const parsed = JSON.parse(slice)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { envelope: null, error: 'truncated_json' }
    }
    return { envelope: parsed, error: null }
  } catch {
    return { envelope: null, error: 'truncated_json' }
  }
}

/**
 * Extrai e valida o `unit_result` de um envelope já parseado.
 *
 * @param {Record<string, unknown> | null} envelope
 * @returns {{ unit_result: object | null, valid: boolean, errors: unknown[], cited: boolean }}
 */
export function parseUnitResult(envelope) {
  const structuredOutput = envelope?.structured_output

  if (
    envelope == null ||
    structuredOutput === undefined ||
    structuredOutput === null ||
    typeof structuredOutput !== 'object' ||
    Array.isArray(structuredOutput)
  ) {
    return { unit_result: null, valid: false, errors: ['structured_output ausente'], cited: false }
  }

  const result = validate('unit-result', structuredOutput)
  const sources = /** @type {{ sources?: unknown }} */ (structuredOutput).sources
  const cited = result.valid && Array.isArray(sources) && sources.length > 0

  return {
    unit_result: /** @type {object} */ (structuredOutput),
    valid: result.valid,
    errors: result.errors,
    cited,
  }
}

/**
 * Extrai o custo reportado de um envelope, sem nunca inventar valores (regra I45).
 *
 * @param {Record<string, unknown> | null | undefined} envelope
 * @param {string} [role]
 * @returns {{ cost_usd: number | null, cost_source: 'reported' | 'unknown', cost_basis: string | null, models: Array<{ role: string, model_id: string }> }}
 */
export function parseUsage(envelope, role = 'maker') {
  const totalCost = envelope?.total_cost_usd
  const modelUsage = /** @type {Record<string, { costBasis?: unknown }>} */ (envelope?.modelUsage) ?? {}
  const modelIds = Object.keys(modelUsage).sort()
  const models = modelIds.map((modelId) => ({ role, model_id: modelId }))

  let costBasis = null
  for (const modelId of modelIds) {
    const candidate = modelUsage[modelId]?.costBasis
    if (typeof candidate === 'string') {
      costBasis = candidate
      break
    }
  }

  if (typeof totalCost === 'number' && Number.isFinite(totalCost)) {
    return { cost_usd: totalCost, cost_source: 'reported', cost_basis: costBasis, models }
  }

  return { cost_usd: null, cost_source: 'unknown', cost_basis: costBasis, models }
}
