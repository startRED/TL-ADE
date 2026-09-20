// @ts-check
import { AdeError } from '../../journal/errors.js'

/**
 * Monta o argv para invocar a CLI `codex` real seguindo as invariantes normativas da spec v2 / ADR 0006.
 *
 * Invariantes:
 * 1. Prompt sempre por stdin com `codex exec -`, nunca em argv.
 * 2. Schema é arquivo (`--output-schema <file>`), não inline. Resultado em `-o <file>`.
 * 3. `--color never` em toda chamada.
 * 4. `--sandbox read-only` para Checker (e `--sandbox workspace-write` para Maker).
 * 5. `--ignore-user-config` e `--skip-git-repo-check`.
 *
 * @param {{
 *   role?: string,
 *   cwd: string,
 *   schemaPath?: string,
 *   resultFile: string,
 *   model?: string,
 *   effort?: string,
 *   sandbox?: string,
 * }} opts
 * @returns {string[]}
 */
export function buildCodexArgs(opts) {
  const {
    role = 'checker_round',
    cwd,
    schemaPath,
    resultFile,
    model = 'gpt-5.6-terra',
    effort,
    sandbox = role === 'maker' ? 'workspace-write' : 'read-only',
  } = opts ?? {}

  if (typeof cwd !== 'string' || cwd === '') {
    throw new AdeError('invalid_codex_args', 'cwd inválido', 2)
  }
  if (typeof resultFile !== 'string' || resultFile === '') {
    throw new AdeError('invalid_codex_args', 'resultFile inválido', 2)
  }
  if (typeof model !== 'string' || model === '') {
    throw new AdeError('invalid_codex_args', 'model inválido', 2)
  }

  const isChecker = role.startsWith('checker')
  if (isChecker && sandbox !== 'read-only') {
    throw new AdeError('invalid_codex_args', 'Checker não pode ter permissão de escrita; sandbox deve ser read-only', 4)
  }

  const args = [
    'exec',
    '-',
    '--json',
    '--color',
    'never',
    '--sandbox',
    sandbox,
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-C',
    cwd,
  ]

  if (schemaPath) {
    args.push('--output-schema', schemaPath)
  }

  args.push('-o', resultFile)
  args.push('-m', model)

  const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  if (effort !== undefined && effort !== null) {
    if (typeof effort !== 'string' || !VALID_EFFORTS.includes(effort)) {
      throw new AdeError('invalid_codex_args', `effort inválido: ${effort}`, 2)
    }
    args.push('-c', `model_reasoning_effort="${effort}"`)
  }

  return args
}
