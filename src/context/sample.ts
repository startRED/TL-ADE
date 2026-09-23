/**
 * Seleciona a coleção candidata e o resumo de cada tipo de insumo.
 */
function selectCandidates(kind: string, lines: string[]): { summary: string; candidates: string[] } {
  if (kind === 'log') {
    const errorWarn = lines.filter((l) => /ERROR|WARN|FATAL/i.test(l))
    return {
      summary: `Log amostrado: ${lines.length} linhas, ${errorWarn.length} alertas/erros encontrados`,
      candidates: errorWarn.length > 0 ? errorWarn : lines,
    }
  }

  if (kind === 'diff') {
    const changed = lines.filter((l) => l.startsWith('+') || l.startsWith('-'))
    return {
      summary: `Diff com alterações: ${changed.length} linhas alteradas`,
      candidates: lines,
    }
  }

  if (kind === 'documentation') {
    const headings = lines.filter((l) => /^#+\s+/.test(l))
    return {
      summary: `Documentação amostrada com ${headings.length} seções`,
      candidates: headings.length > 0 ? headings : lines,
    }
  }

  if (kind === 'integration_failure') {
    const failLines = lines.filter((l) => /fail|error|assertion/i.test(l))
    return {
      summary: `Falha de integração detectada com ${failLines.length} erro(s)`,
      candidates: lines,
    }
  }

  return { summary: `Entrada amostrada para ${kind}`, candidates: lines }
}

/**
 * Amostrador de insumos de contexto preservando sempre a referência ao bruto (raw_ref).
 */
export function sampleInput({
  kind,
  rawRef,
  content = '',
  budget = 100,
  cursor = 0,
}: {
        kind: 'log' | 'diff' | 'documentation' | 'integration_failure' | string
        rawRef: string
        content?: string
        budget?: number
        cursor?: number
    }): {
    summary: string
    items: any[]
    next_cursor: number | null
    raw_ref: string
} {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('kind deve ser uma string não vazia')
  }
  if (typeof rawRef !== 'string' || rawRef.length === 0) {
    throw new TypeError('rawRef obrigatório: o bruto nunca é descartado')
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new TypeError('cursor deve ser um inteiro não negativo')
  }
  if (!Number.isInteger(budget) || budget < 0) {
    throw new TypeError('budget deve ser um inteiro não negativo')
  }

  const lines = content.split('\n').filter((l) => l.length > 0)
  const { summary, candidates } = selectCandidates(kind, lines)

  // Cursor e orçamento valem sobre a mesma coleção candidata, e a continuação
  // é calculada a partir dela — nunca contra o bruto completo.
  const items = candidates.slice(cursor, cursor + budget)
  const consumed = cursor + items.length
  const next_cursor = consumed < candidates.length ? consumed : null

  return { summary, items, next_cursor, raw_ref: rawRef }
}
