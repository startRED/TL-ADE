import { validate } from '../../schema/index.ts'

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * Remove sequências de escape ANSI (CSI) de um texto.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/**
 * Extrai o envelope JSON de um stdout bruto do `claude`, tolerando ruído ANSI ao redor.
 */
export function parseClaudeOutput(stdout: string): { envelope: Record<string, unknown> | null; error: null | 'empty' | 'not_json' | 'truncated_json' } {
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
 */
export function parseUnitResult(envelope: Record<string, unknown> | null): { unit_result: object | null; valid: boolean; errors: unknown[]; cited: boolean } {
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
  const sources = (structuredOutput as Record<string, any>).sources
  const cited = result.valid && Array.isArray(sources) && sources.length > 0

  return {
    unit_result: (structuredOutput),
    valid: result.valid,
    errors: result.errors,
    cited,
  }
}

/**
 * Extrai o custo reportado de um envelope, sem nunca inventar valores (regra I45).
 */
export function parseUsage(envelope: Record<string, unknown> | null | undefined, role: string = 'maker'): { cost_usd: number | null; cost_source: 'reported' | 'unknown'; cost_basis: string | null; models: Array<{ role: string; model_id: string }> } {
  const totalCost = envelope?.total_cost_usd
  const modelUsage = (envelope?.modelUsage ?? {}) as Record<string, any>
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

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * Extrai os contadores de tokens e custo de um envelope Claude.
 */
export function parseTokens(envelope: Record<string, unknown> | null | undefined): { input: number; cache_write: number; cache_read: number; output: number; usd: number | null; source: 'reported' } | { source: 'unavailable' } {
  const u = envelope?.usage as Record<string, any> | undefined

  if (
    u &&
    isNonNegInt(u.input_tokens) &&
    isNonNegInt(u.cache_creation_input_tokens) &&
    isNonNegInt(u.cache_read_input_tokens) &&
    isNonNegInt(u.output_tokens)
  ) {
    const c = envelope?.total_cost_usd
    const usd = typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null
    return {
      input: (u.input_tokens),
      cache_write: (u.cache_creation_input_tokens),
      cache_read: (u.cache_read_input_tokens),
      output: (u.output_tokens),
      usd,
      source: 'reported',
    }
  }

  return { source: 'unavailable' }
}
