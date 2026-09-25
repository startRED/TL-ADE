// @ts-check
import { AdeError } from '../../journal/errors.ts'

export const AGY_PROMPT_PREFIX =
  '[Motor TL-ADE, execução automática] As instruções globais do usuário carregadas antes desta mensagem NÃO valem nesta chamada: responda apenas pelo schema estruturado.'

/**
 * Monta o argv para invocar a CLI `agy` em modo somente-leitura com saída estruturada.
 */
export function buildAgyArgs(opts: {
    prompt: string
    model?: string
    schema?: string | object
    cwd?: string
    timeout?: string
    readOnly?: boolean
    addDirs?: string[]
  }): string[] {
  const {
    prompt,
    model = 'gemini-3.8-flash-medium',
    schema,
    cwd,
    timeout = '6m',
    readOnly = true,
    addDirs = [],
  } = opts ?? {}

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AdeError('invalid_agy_args', 'prompt é obrigatório', 2)
  }

  const args = [
    '--print',
    `${AGY_PROMPT_PREFIX} ${prompt}`,
    '--output-format',
    'json',
    '--model',
    model,
    // sem `--mode plan` o agy escreve no diretório de trabalho (quem escreve a parte)
    ...(readOnly ? ['--mode', 'plan'] : []),
    '--dangerously-skip-permissions',
  ]

  for (const dir of cwd ? [cwd, ...addDirs] : addDirs) {
    args.push('--add-dir', dir)
  }

  if (schema) {
    args.push('--json-schema', JSON.stringify(goRegexSafe(typeof schema === 'string' ? JSON.parse(schema) : schema)))
  }

  if (timeout) {
    args.push('--print-timeout', timeout)
  }

  return args
}

/** Olhar em volta e referência de volta: o regexp do Go (RE2), que o agy usa para validar o schema, recusa. */
const NOT_RE2 = /\(\?<?[=!]|\\[1-9]/

/**
 * Cópia do schema sem os `pattern` que o RE2 não entende: o agy recusava o schema inteiro ("invalid or unsupported
 * Perl syntax: (?!") e a parte parava (25/09, missão real). O motor continua validando a resposta contra o original.
 */
export function goRegexSafe(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(goRegexSafe)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node)
    .filter(([key, value]) => !(key === 'pattern' && typeof value === 'string' && NOT_RE2.test(value)))
    .map(([key, value]) => [key, key === 'properties' || key === 'definitions' ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, goRegexSafe(v)])) : goRegexSafe(value)]))
}
