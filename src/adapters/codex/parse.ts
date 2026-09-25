// @ts-check
import fs from 'node:fs'
import { validate } from '../../schema/index.ts'

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * Remove sequências de escape ANSI de um texto.
 */
export function stripAnsi(text: string): string {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : ''
}

/**
 * Parseia a saída de execução do Codex a partir do arquivo de resultado gravado ou do stdout.
 *
 * @param stdout Saída padrão bruta.
 * @param [resultFilePath] Caminho do arquivo -o com resultado.
 */
export function parseCodexOutput(stdout: string, resultFilePath: string): {
  envelope: Record<string, unknown> | null
  error: null | 'empty' | 'not_json' | 'truncated_json'
} {
  if (resultFilePath && fs.existsSync(resultFilePath)) {
    try {
      const content = fs.readFileSync(resultFilePath, 'utf8').trim()
      if (content.length > 0) {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object') {
          return { envelope: parsed, error: null }
        }
      }
    } catch {
      // continua tentando parsear pelo stdout
    }
  }

  const clean = stripAnsi(stdout).trim()
  if (clean === '') {
    return { envelope: null, error: 'empty' }
  }

  const first = clean.indexOf('{')
  if (first === -1) {
    return { envelope: null, error: 'not_json' }
  }
  const last = clean.lastIndexOf('}')
  const slice = clean.slice(first, last + 1)

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
 * Extrai e valida o `review_result` de um envelope parseado do Codex.
 */
export function parseReviewResult(envelope: Record<string, unknown> | null): {
  review_result: any | null
  valid: boolean
  errors: unknown[]
  cited: boolean
} {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { review_result: null, valid: false, errors: ['envelope ausente'], cited: false }
  }

  // O resultado do Codex pode vir em structured_output ou diretamente no arquivo de saída
  const structured = envelope.structured_output ?? envelope
  const val = validate('review-result', structured)
  const sources = (structured as Record<string, any> | null)?.sources
  const cited = val.valid && Array.isArray(sources) && sources.length > 0

  return {
    review_result: structured,
    valid: val.valid,
    errors: val.errors,
    cited,
  }
}

/**
 * Tokens da última volta na saída --json do codex (turn.completed). O resultado estruturado vem do arquivo de
 * resultado e não traz uso; sem isto a revisão do Codex ficava sem tokens e sem custo (25/09). input_tokens já inclui
 * o cache lido: a entrada nova é a diferença.
 */
export function parseCodexStreamUsage(stdout: string): { input: number; output: number; cache_read: number; cache_write: number; usd: null; source: 'reported' } | null {
  let last: any = null
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.includes('"turn.completed"')) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'turn.completed' && ev.usage) last = ev.usage
    } catch {
      // linha partida: fica a anterior
    }
  }
  if (!last || typeof last.input_tokens !== 'number' || typeof last.output_tokens !== 'number') return null
  const cached = typeof last.cached_input_tokens === 'number' ? last.cached_input_tokens : 0
  return { input: Math.max(0, last.input_tokens - cached), output: last.output_tokens, cache_read: cached, cache_write: typeof last.cache_write_input_tokens === 'number' ? last.cache_write_input_tokens : 0, usd: null, source: 'reported' }
}

/**
 * Extrai tokens e contadores de uso de um envelope Codex.
 */
export function parseCodexTokens(envelope: Record<string, unknown> | null | undefined): {
  input: number
  output: number
  usd: null
  source: 'reported' | 'unavailable'
} {
  const u = envelope?.usage as Record<string, any> | undefined
  if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    return {
      input: u.input_tokens,
      output: u.output_tokens,
      usd: null,
      source: 'reported',
    }
  }
  return { input: 0, output: 0, usd: null, source: 'unavailable' }
}
