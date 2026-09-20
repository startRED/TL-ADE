/**
 * Converte um padrão glob simples em expressão regular.
 * @param {string} pattern
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/')
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Resolve as regras de donos de escopo correspondentes exclusivamente aos caminhos tocados.
 *
 * @param {{
 *   paths: string[],
 *   rules: Array<{ pattern: string, owner: string, ref?: string }>,
 * }} options
 * @returns {Array<{ pattern: string, owner: string, ref?: string }>}
 */
export function resolveScopeOwners({ paths = [], rules = [] }) {
  const matched = []
  const seenOwners = new Set()

  const normalizedPaths = paths.map((p) => p.replace(/\\/g, '/'))

  for (const rule of rules) {
    const rx = patternToRegex(rule.pattern)
    const matchesAny = normalizedPaths.some((p) => rx.test(p))

    if (matchesAny && !seenOwners.has(rule.owner)) {
      seenOwners.add(rule.owner)
      matched.push(rule)
    }
  }

  return matched
}
