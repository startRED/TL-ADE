import fs from 'node:fs'
import { AdeError } from '../../journal/errors.ts'
import { isolationArgs } from './isolation.ts'

const SCHEMA_URL = new URL('../../../schemas/unit-result.schema.json', import.meta.url)
const REVIEW_SCHEMA_URL = new URL('../../../schemas/review-result.schema.json', import.meta.url)

// O revisor é só leitura: sem ferramenta que escreve nem shell (o Claude não tem sandbox de leitura para o Bash).
// ponytail: sem Bash o revisor não roda comandos; liberar os de leitura quando houver sandbox de leitura no Claude.
const CHECKER_DISALLOWED = 'Bash,Edit,MultiEdit,Write,NotebookEdit'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CLAUDE_PROMPT = 'Siga a seção task do contexto anexado e responda somente pelo schema.'

function loadSchemaJson(url: URL) {
  const raw = JSON.parse(fs.readFileSync(url, 'utf8'))
  delete raw.$id
  delete raw.$schema
  return JSON.stringify(raw)
}

/**
 * Monta o argv para invocar o `claude` real seguindo a ordem fixa de flags decidida para o Slice 1.
 * Quem escreve (`maker`, o padrão) responde pelo unit-result; quem revisa (`checker_*`) pelo review-result, só leitura.
 */
/**
 * Com `resume` a chamada retoma a sessão `sessionId` (ADR 0046): o pack repete no prompt de sistema, para o cache da
 * conversa valer, e o prompt vem pela entrada padrão (o que mudou na rodada pode passar do teto do argv do Windows).
 */
export function buildClaudeArgs(opts: { sessionId: string; packPath: string; settingsPath: string; maxBudgetUsd: number; model?: string; effort?: string; mcpConfigPath?: string; maxTurns?: number; role?: string; resume?: boolean }): string[] {
  const { sessionId, packPath, settingsPath, maxBudgetUsd, model, role = 'maker' } = opts ?? {}

  if (typeof sessionId !== 'string' || (!SESSION_ID_RE.test(sessionId) && sessionId !== 's')) {
    throw new AdeError('invalid_claude_args', 'sessionId inválido', 2)
  }
  if (typeof packPath !== 'string' || packPath === '') {
    throw new AdeError('invalid_claude_args', 'packPath inválido', 2)
  }
  if (typeof settingsPath !== 'string' || settingsPath === '') {
    throw new AdeError('invalid_claude_args', 'settingsPath inválido', 2)
  }
  if (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new AdeError('invalid_claude_args', 'maxBudgetUsd inválido', 2)
  }
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new AdeError('invalid_claude_args', 'model inválido', 2)
  }
  if (typeof role !== 'string' || !(role === 'maker' || role.startsWith('checker'))) {
    throw new AdeError('invalid_claude_args', `papel sem suporte no adapter claude: ${String(role)}`, 2)
  }
  const checker = role !== 'maker'

  const args = [
    '-p',
    ...(opts.resume ? [] : [CLAUDE_PROMPT]),
    '--output-format',
    'json',
    '--json-schema',
    loadSchemaJson(checker ? REVIEW_SCHEMA_URL : SCHEMA_URL),
    opts.resume ? '--resume' : '--session-id',
    sessionId,
    '--max-budget-usd',
    String(maxBudgetUsd),
    ...isolationArgs(settingsPath),
    '--permission-mode',
    'bypassPermissions',
    '--permission-prompts',
    'none',
    '--disallowedTools',
    checker ? CHECKER_DISALLOWED : 'Bash(git push*),Bash(git commit*),Bash(gh pr*)',
    '--append-system-prompt-file',
    packPath,
  ]

  if (model !== undefined) {
    args.push('--model', model)
  }

  if (opts?.effort !== undefined) {
    if (!EFFORTS.includes(opts.effort)) throw new AdeError('invalid_claude_args', `effort inválido: ${opts.effort}`, 2)
    args.push('--effort', opts.effort)
  }

  if (opts?.maxTurns !== undefined) {
    if (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1) {
      throw new AdeError('invalid_claude_args', 'maxTurns inválido', 2)
    }
    args.push('--max-turns', String(opts.maxTurns))
  }

  if (opts?.mcpConfigPath !== undefined) {
    if (typeof opts.mcpConfigPath !== 'string' || opts.mcpConfigPath === '') {
      throw new AdeError('invalid_claude_args', 'mcpConfigPath inválido', 2)
    }
    args.push('--mcp-config', opts.mcpConfigPath)
  }

  return args
}
