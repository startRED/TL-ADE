import fs from 'node:fs'
import { AdeError } from '../../journal/errors.ts'

const SCHEMA_URL = new URL('../../../schemas/unit-result.schema.json', import.meta.url)

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CLAUDE_PROMPT = 'Siga a seção task do contexto anexado e responda somente pelo schema.'

function loadSchemaJson() {
  const raw = JSON.parse(fs.readFileSync(SCHEMA_URL, 'utf8'))
  delete raw.$id
  delete raw.$schema
  return JSON.stringify(raw)
}

/**
 * Monta o argv para invocar o `claude` real seguindo a ordem fixa de flags decidida para o Slice 1.
 *
 * @param {{ sessionId: string, packPath: string, maxBudgetUsd: number, model?: string, mcpConfigPath?: string }} opts
 * @returns {string[]}
 */
export function buildClaudeArgs(opts) {
  const { sessionId, packPath, maxBudgetUsd, model } = opts ?? {}

  if (typeof sessionId !== 'string' || (!SESSION_ID_RE.test(sessionId) && sessionId !== 's')) {
    throw new AdeError('invalid_claude_args', 'sessionId inválido', 2)
  }
  if (typeof packPath !== 'string' || packPath === '') {
    throw new AdeError('invalid_claude_args', 'packPath inválido', 2)
  }
  if (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new AdeError('invalid_claude_args', 'maxBudgetUsd inválido', 2)
  }
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new AdeError('invalid_claude_args', 'model inválido', 2)
  }

  const args = [
    '-p',
    CLAUDE_PROMPT,
    '--output-format',
    'json',
    '--json-schema',
    loadSchemaJson(),
    '--session-id',
    sessionId,
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--safe-mode',
    '--permission-mode',
    'bypassPermissions',
    '--permission-prompts',
    'none',
    '--disallowedTools',
    'Bash(git push*),Bash(gh pr*)',
    '--append-system-prompt-file',
    packPath,
  ]

  if (model !== undefined) {
    args.push('--model', model)
  }

  if (opts?.mcpConfigPath !== undefined) {
    if (typeof opts.mcpConfigPath !== 'string' || opts.mcpConfigPath === '') {
      throw new AdeError('invalid_claude_args', 'mcpConfigPath inválido', 2)
    }
    args.push('--mcp-config', opts.mcpConfigPath)
  }

  return args
}
