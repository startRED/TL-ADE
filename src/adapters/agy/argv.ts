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
  }): string[] {
  const {
    prompt,
    model = 'gemini-3.8-flash-medium',
    schema,
    cwd,
    timeout = '6m',
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
    '--mode',
    'plan',
    '--dangerously-skip-permissions',
  ]

  if (cwd) {
    args.push('--add-dir', cwd)
  }

  if (schema) {
    const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema)
    args.push('--json-schema', schemaStr)
  }

  if (timeout) {
    args.push('--print-timeout', timeout)
  }

  return args
}
