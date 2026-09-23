// Diagnóstico de tipos ou lint sem linha e coluna: código que só desceu de linha não vira erro novo.
export interface Diagnostic {
  file: string
  code: string
  message: string
}

export type DiagnosticTool = 'tsc' | 'oxlint'

// tsc --pretty false: "arq(10,3): error TS2322: mensagem"
const TSC = /^(\S[^(]*?)\(\d+,\d+\):\s*(?:error|warning)\s+(TS\d+):\s*(.+)$/
// oxlint --format unix: "arq:10:3: mensagem [Error/eslint(regra)]"
const OXLINT = /^(\S[^:]*?|[A-Za-z]:[^:]*?):\d+:\d+:\s*(.+?)(?:\s+\[\w+\/([^\]]+)\])?$/

/**
 * Lê os diagnósticos da saída do tsc (`--pretty false`) ou do oxlint (`--format unix`). Linha fora do formato é ignorada.
 */
export function parseDiagnostics(tool: DiagnosticTool, output: string): Diagnostic[] {
  if (tool !== 'tsc' && tool !== 'oxlint') throw new TypeError(`ferramenta de diagnóstico desconhecida: ${String(tool)}`)
  const rows: Diagnostic[] = []
  for (const line of String(output).split(/\r?\n/)) {
    const l = line.trim()
    if (tool === 'tsc') {
      const m = TSC.exec(l)
      if (m) rows.push({ file: m[1].replace(/\\/g, '/'), code: m[2], message: m[3].trim() })
    } else {
      const m = OXLINT.exec(l)
      if (m) rows.push({ file: m[1].replace(/\\/g, '/'), code: m[3] ?? '', message: m[2].trim() })
    }
  }
  return rows
}

const key = (d: Diagnostic): string => `${d.file}\u0000${d.code}\u0000${d.message}`

/**
 * Diagnósticos de `after` cuja tripla (arquivo, código, mensagem) não aparece em `before`: tripla que já estava na linha
 * de base não é nova, repita-se quantas vezes for.
 */
export function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const known = new Set(before.map(key))
  return after.filter((d) => !known.has(key(d)))
}
