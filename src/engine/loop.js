// @ts-check

export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[Tt][\d:.]+[Zz]\s?/i
export const TIME_RE = /\b(?:\d+(?:\.\d+)?\s?(?:ms|s|m|h)|\d{1,2}:\d{2}(?::\d{2})?)\b/g
export const HEX_RE = /\b[0-9a-f]{7,}\b/g
export const PATH_RE = /(?:[A-Za-z]:)?[\\/][\w.\\/-]+/g
export const NUM_RE = /\b\d+(?:\.\d+)?\b/g

/**
 * Normaliza uma mensagem ou assinatura para comparação determinística.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  if (typeof text !== 'string') return ''
  let s = text.toLowerCase()
  s = s.replace(TIMESTAMP_RE, '')
  s = s.replace(TIME_RE, '<t>')
  s = s.replace(HEX_RE, '<hex>')
  s = s.replace(PATH_RE, '<path>')
  s = s.replace(NUM_RE, '<n>')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Detecta ciclos, estagnação ou oscilação em assinaturas de execução.
 *
 * @param {string[]} signatures
 * @param {{ threshold?: number }} [options]
 * @returns {{
 *   kind: 'none' | 'oscillation' | 'stagnation',
 *   signature: string | null,
 * }}
 */
export function detectLoop(signatures, { threshold = 2 } = {}) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return { kind: 'none', signature: null }
  }

  const norm = signatures.map((s) => (typeof s === 'string' ? normalize(s) : String(s)))
  const last = norm[norm.length - 1]

  // Checagem de estagnação: as últimas N assinaturas são idênticas
  let consecutive = 1
  for (let i = norm.length - 2; i >= 0; i--) {
    if (norm[i] === last) {
      consecutive++
    } else {
      break
    }
  }
  if (consecutive >= threshold) {
    return { kind: 'stagnation', signature: last }
  }

  // Checagem de oscilação: ex. A, B, A (retorno a assinatura anterior após variação)
  if (norm.length >= 3) {
    if (norm[norm.length - 1] === norm[norm.length - 3] && norm[norm.length - 1] !== norm[norm.length - 2]) {
      return { kind: 'oscillation', signature: last }
    }
    for (let i = norm.length - 3; i >= 0; i--) {
      if (norm[i] === last && norm[norm.length - 2] !== last) {
        return { kind: 'oscillation', signature: last }
      }
    }
  }

  return { kind: 'none', signature: null }
}
