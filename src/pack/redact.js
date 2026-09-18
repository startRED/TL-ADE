import { SECRET_PATTERNS } from '../contain/secrets.js'
import { AdeError } from '../journal/errors.js'

/**
 * @typedef {Object} RedactionCount
 * @property {string} pattern
 * @property {number} count
 */

/**
 * @typedef {Object} RedactResult
 * @property {string} text
 * @property {RedactionCount[]} redactions
 */

/**
 * Redige segredos conhecidos de um texto, trocando cada casamento por
 * `[REDACTED:<id do padrão>]`. Reusa SECRET_PATTERNS do containment para que
 * pack e contain nunca discordem sobre o que é segredo.
 *
 * @param {string} text
 * @returns {RedactResult}
 */
export function redactText(text) {
  if (typeof text !== 'string') {
    throw new AdeError('invalid_argument', 'texto inválido: precisa ser string', 2)
  }

  let result = text
  /** @type {RedactionCount[]} */
  const redactions = []

  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags)
    let count = 0
    result = result.replace(re, () => {
      count++
      return `[REDACTED:${p.id}]`
    })
    if (count > 0) {
      redactions.push({ pattern: p.id, count })
    }
  }

  return { text: result, redactions }
}
