/** Linhas por bloco na varredura de fallback: a leitura nunca traz o arquivo inteiro. */
const BLOCK_LINES = 200

/**
 * Consulta símbolos ou trechos de código com fallback determinístico para workspace quando não resolvido pelo IR.
 *
 * @param {{
 *   kind?: 'symbol' | 'text' | 'file',
 *   query: string,
 *   cursor?: number,
 *   budget?: number,
 *   workspace?: import('../workspace/port.js').WorkspacePort,
 *   ir?: any,
 * }} options
 * @returns {Promise<{
 *   summary: string,
 *   items: any[],
 *   next_cursor: number | null,
 *   raw_ref: string,
 * }>}
 */
export async function queryCode({
  kind: _kind,
  query,
  cursor = 0,
  budget = 100,
  workspace,
  ir,
}) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new TypeError('query deve ser uma string não vazia')
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new TypeError('cursor deve ser um inteiro não negativo')
  }
  if (!Number.isInteger(budget) || budget < 0) {
    throw new TypeError('budget deve ser um inteiro não negativo')
  }

  // 1. Tenta resolver pelo IR se disponível
  /** @type {any[]} */
  const irSymbols = ir?.data?.symbols || []
  const foundInIr = irSymbols.filter((/** @type {any} */ s) => s.name === query)
  if (foundInIr.length > 0) {
    const page = foundInIr.slice(cursor, cursor + budget)
    const first = page[0] ?? foundInIr[0]
    return {
      summary: `Resolvido via IR: ${foundInIr.length} símbolo(s) encontrado(s)`,
      items: page,
      next_cursor: cursor + page.length < foundInIr.length ? cursor + page.length : null,
      raw_ref: first.source ? `file:${first.source}` : `repo:symbol:${first.name}`,
    }
  }

  // 2. Fallback determinístico para busca limitada no workspace: nunca lê o
  // arquivo inteiro, só blocos de BLOCK_LINES, e para assim que junta uma
  // ocorrência além da página pedida (o extra decide o next_cursor).
  if (workspace) {
    const snap = await workspace.snapshot()
    /** @type {any[]} */
    const matches = []
    const wanted = cursor + budget

    outer: for (const relPath of snap.paths) {
      let offset = 0
      for (;;) {
        const read = await workspace.read(relPath, { offset, limit: BLOCK_LINES })
        for (let i = 0; i < read.items.length; i++) {
          if (!read.items[i].includes(query)) {
            continue
          }
          matches.push({ path: relPath, line: offset + i + 1, text: read.items[i] })
          if (matches.length > wanted) {
            break outer
          }
        }
        if (read.next_cursor === null) {
          break
        }
        offset = read.next_cursor
      }
    }

    if (matches.length > 0) {
      const page = matches.slice(cursor, cursor + budget)
      const consumed = cursor + page.length
      // Com orçamento zero a página é vazia, mas a continuação ainda é informada.
      const anchor = page[0] ?? matches[Math.min(cursor, matches.length - 1)]
      return {
        summary: `Busca no workspace: ${matches.length} ocorrência(s) encontrada(s) para "${query}"`,
        items: page,
        next_cursor: consumed < matches.length ? consumed : null,
        raw_ref: `file:${anchor.path}#L${anchor.line}`,
      }
    }
  }

  return {
    summary: `Nenhuma ocorrência encontrada para "${query}"`,
    items: [],
    next_cursor: null,
    raw_ref: `query:${query}`,
  }
}
