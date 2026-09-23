import fs from 'node:fs/promises'
import path from 'node:path'

// Mapa do código sem IA: símbolo@linha por arquivo, para o maker ler só o trecho (lição de proto/server.mjs codeMap).

/** Acima disso o arquivo é gerado ou minificado: fica fora do mapa e dos trechos. */
const MAX_FILE_CHARS = 400000
/** Abaixo disso o arquivo vai inteiro: mapear custa mais do que ler. */
const WHOLE_FILE_LINES = 40
const MAX_SYMBOLS_PER_FILE = 40

const TS_JS = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*[=<]|enum\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>))/
const PYTHON = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/
const GO = /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/
const RUST = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const)\s+)*(?:fn|struct|enum|trait|impl(?:<[^>]*>)?)\s+([A-Za-z_]\w*)/
// Demais linguagens: declaração com palavra-chave, ou método com modificador antes do tipo de retorno.
const KEYWORD = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|override|virtual|async|export|inline|data|suspend|local)\s+)*(?:class|struct|interface|enum|record|object|trait|module|defmodule|defp?|fun|func|function|fn)\s+([A-Za-z_][\w.]*)|^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/
// CSS: at-rule ou seletor de regra na coluna zero (topo do arquivo).
const CSS = /^(@[\w-]+[^{;]*)|^([^\s@{}/][^{]*?)\s*\{/
// Atributo id com aspas duplas, simples ou sem aspas; o espaço antes exclui data-id e afins.
const HTML_ID = /<[a-zA-Z][\w-]*\b[^>]*?\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/
const HTML_LANDMARK = /^\s*<(header|main|nav|footer|section|article|aside|form|dialog|template)\b/
const MARKDOWN = /^#{1,6}\s+(.+?)\s*#*\s*$/

function firstGroup(pattern: RegExp): (line: string) => string | null {
  return (line) => {
    const match = pattern.exec(line)
    return match?.slice(1).find(Boolean)?.trim() ?? null
  }
}

const RULES: Array<{ ext: RegExp; symbol: (line: string) => string | null }> = [
  { ext: /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i, symbol: firstGroup(TS_JS) },
  { ext: /\.py$/i, symbol: firstGroup(PYTHON) },
  { ext: /\.go$/i, symbol: firstGroup(GO) },
  { ext: /\.rs$/i, symbol: firstGroup(RUST) },
  { ext: /\.(?:java|kts?|cs|php|rb|swift|dart|c|h|cc|cpp|hpp|ex|exs|lua|scala)$/i, symbol: firstGroup(KEYWORD) },
  { ext: /\.css$/i, symbol: firstGroup(CSS) },
  { ext: /\.html?$/i, symbol: (line) => firstGroup(HTML_ID)(line) ?? HTML_LANDMARK.exec(line)?.[1] ?? null },
  { ext: /\.md$/i, symbol: firstGroup(MARKDOWN) },
]

const UTF8 = new TextDecoder('utf-8', { fatal: true })
/**
 * Controles que aparecem em texto, pela tabela text_chars do libmagic: BEL, BS, HT, LF, VT, FF, CR e ESC.
 * Qualquer outro byte abaixo de 0x20 (NUL incluído) ou o DEL marca binário, mesmo sendo UTF-8 válido.
 */
const TEXT_CONTROLS = new Set([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b])

/**
 * Lê o arquivo como linhas; `null` quando ainda não existe (a parte vai criá-lo), é binário, grande demais
 * ou passa por link simbólico (o alvo pode estar fora do escopo ou do workspace).
 */
async function readLines(dir: string, file: string): Promise<{ text: string; lines: string[] } | null> {
  let real: string
  try {
    real = await fs.realpath(path.join(dir, file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (path.relative(await fs.realpath(dir), real) !== path.normalize(file)) return null
  const buffer = await fs.readFile(real)
  let text: string
  try {
    text = UTF8.decode(buffer)
  } catch (error) {
    if (error instanceof TypeError) return null // bytes inválidos em UTF-8: binário
    throw error
  }
  if (text.length > MAX_FILE_CHARS) return null
  // Varredura byte a byte só depois do teto: arquivo gerado enorme não paga o laço.
  if (buffer.some((byte) => (byte < 0x20 && !TEXT_CONTROLS.has(byte)) || byte === 0x7f)) return null
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return { text, lines }
}

function symbolsOf(file: string, lines: string[]): Array<{ name: string; line: number }> {
  const rule = RULES.find((r) => r.ext.test(file))
  if (!rule) return []
  const symbols: Array<{ name: string; line: number }> = []
  lines.forEach((text, i) => {
    const name = rule.symbol(text)
    if (name) symbols.push({ name, line: i + 1 })
  })
  return symbols
}

/**
 * Mapa `caminho (N linhas): nome@linha, ...` dos arquivos; arquivo com menos de 40 linhas vai inteiro.
 */
export async function codeMap(dir: string, files: string[], { maxFiles = 60, maxChars = 7000 }: { maxFiles?: number; maxChars?: number } = {}): Promise<string> {
  const mapped: string[] = []
  const whole: string[] = []
  for (const file of files.slice(0, maxFiles)) {
    const read = await readLines(dir, file)
    if (!read) continue
    const count = read.lines.length
    if (count < WHOLE_FILE_LINES) {
      whole.push(`${file} (${count} linhas, inteiro):\n${read.text}`)
      continue
    }
    const symbols = symbolsOf(file, read.lines)
    if (symbols.length === 0) continue
    const shown = symbols.slice(0, MAX_SYMBOLS_PER_FILE).map((s) => `${s.name}@${s.line}`).join(', ')
    mapped.push(`${file} (${count} linhas): ${shown}${symbols.length > MAX_SYMBOLS_PER_FILE ? ' …' : ''}`)
  }
  if (mapped.length === 0 && whole.length === 0) return ''
  let text = [...mapped, ...whole].join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[... mapa cortado em ${maxChars} caracteres]`
  return `MAPA DO CÓDIGO (símbolo@linha; leia só o trecho que precisa):\n${text}`
}

/**
 * Trechos numerados em volta da declaração de cada símbolo nomeado. Arquivo com menos de 40 linhas
 * fica de fora: o mapa já o entrega inteiro.
 */
export async function symbolExcerpts(dir: string, files: string[], names: string[], { radius = 10 }: { radius?: number } = {}): Promise<string> {
  if (names.length === 0) return ''
  const wanted = new Set(names)
  const blocks: string[] = []
  for (const file of files) {
    const read = await readLines(dir, file)
    if (!read || read.lines.length < WHOLE_FILE_LINES) continue
    for (const symbol of symbolsOf(file, read.lines)) {
      if (!wanted.has(symbol.name)) continue
      const start = Math.max(1, symbol.line - radius)
      const end = Math.min(read.lines.length, symbol.line + radius)
      const body = read.lines.slice(start - 1, end).map((text, i) => `${start + i}: ${text}`).join('\n')
      blocks.push(`${file} linhas ${start}-${end} (${symbol.name}):\n${body}`)
    }
  }
  return blocks.length ? `TRECHOS DOS SÍMBOLOS DO CONTRATO:\n${blocks.join('\n\n')}` : ''
}
