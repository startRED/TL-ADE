/**
 * Converte um padrão glob simples em expressão regular.
 */
function patternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Resolve as regras de donos de escopo correspondentes exclusivamente aos caminhos tocados.
 */
export function resolveScopeOwners({ paths = [], rules = [] }: {
        paths: string[]
        rules: Array<{ pattern: string; owner: string; ref?: string }>
    }): Array<{ pattern: string; owner: string; ref?: string }> {
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
