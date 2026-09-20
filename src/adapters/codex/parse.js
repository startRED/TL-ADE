// @ts-check
import fs from 'node:fs'
import { validate } from '../../schema/index.js'

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * Remove sequências de escape ANSI de um texto.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : ''
}

/**
 * Parseia a saída de execução do Codex a partir do arquivo de resultado gravado ou do stdout.
 *
 * @param {string} stdout Saída padrão bruta.
 * @param {string} [resultFilePath] Caminho do arquivo -o com resultado.
 * @returns {{
 *   envelope: Record<string, unknown> | null,
 *   error: null | 'empty' | 'not_json' | 'truncated_json'
 * }}
 */
export function parseCodexOutput(stdout, resultFilePath) {
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
 *
 * @param {Record<string, unknown> | null} envelope
 * @returns {{
 *   review_result: any | null,
 *   valid: boolean,
 *   errors: unknown[],
 *   cited: boolean
 * }}
 */
export function parseReviewResult(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { review_result: null, valid: false, errors: ['envelope ausente'], cited: false }
  }

  // O resultado do Codex pode vir em structured_output ou diretamente no arquivo de saída
  const structured = envelope.structured_output ?? envelope
  const val = validate('review-result', structured)
  const sources = /** @type {any} */ (structured)?.sources
  const cited = val.valid && Array.isArray(sources) && sources.length > 0

  return {
    review_result: structured,
    valid: val.valid,
    errors: val.errors,
    cited,
  }
}

/**
 * Extrai tokens e contadores de uso de um envelope Codex.
 *
 * @param {Record<string, unknown> | null | undefined} envelope
 * @returns {{
 *   input: number,
 *   output: number,
 *   usd: null,
 *   source: 'reported' | 'unavailable'
 * }}
 */
export function parseCodexTokens(envelope) {
  const u = /** @type {any} */ (envelope?.usage)
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
