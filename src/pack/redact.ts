import { SECRET_PATTERNS } from '../contain/secrets.ts'
import { AdeError } from '../journal/errors.ts'

export type RedactionCount = {
  pattern: string
  count: number
}

export type RedactResult = {
  text: string
  redactions: RedactionCount[]
}

/**
 * Redige segredos conhecidos de um texto, trocando cada casamento por
 * `[REDACTED:<id do padrão>]`. Reusa SECRET_PATTERNS do containment para que
 * pack e contain nunca discordem sobre o que é segredo.
 *
 */
export function redactText(text: string): RedactResult {
  if (typeof text !== 'string') {
    throw new AdeError('invalid_argument', 'texto inválido: precisa ser string', 2)
  }

  let result = text
  const redactions: RedactionCount[] = []

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
