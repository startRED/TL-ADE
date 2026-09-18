import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import { buildClaudeArgs, CLAUDE_PROMPT } from '../src/adapters/claude/argv.js'

const SCHEMA_PATH = fileURLToPath(new URL('../schemas/unit-result.schema.json', import.meta.url))

describe('claude argv', () => {
  // AC1: sessionId UUID, packPath e maxBudgetUsd 0.25 -> array na ordem fixa das flags,
  // --disallowedTools seguido do argumento único, sem --bare; e --model é acrescentado só quando informado.
  test('buildClaudeArgs_orders_fixed_flags_and_includes_disallowed_tools_as_single_argument', () => {
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const packPath = '/p/pack.md'

    const args = buildClaudeArgs({ sessionId, packPath, maxBudgetUsd: 0.25 })

    const schemaRaw = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
    delete schemaRaw.$id
    delete schemaRaw.$schema
    const expectedSchemaJson = JSON.stringify(schemaRaw)

    expect(args).toEqual([
      '-p',
      CLAUDE_PROMPT,
      '--output-format',
      'json',
      '--json-schema',
      expectedSchemaJson,
      '--session-id',
      sessionId,
      '--max-budget-usd',
      '0.25',
      '--safe-mode',
      '--permission-mode',
      'bypassPermissions',
      '--permission-prompts',
      'none',
      '--disallowedTools',
      'Bash(git push*),Bash(gh pr*)',
      '--append-system-prompt-file',
      packPath,
    ])

    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash(git push*),Bash(gh pr*)')
    expect(args.includes('--bare')).toBe(false)
    expect(CLAUDE_PROMPT).toBe('Siga a seção task do contexto anexado e responda somente pelo schema.')

    const withModel = buildClaudeArgs({ sessionId, packPath, maxBudgetUsd: 0.25, model: 'haiku' })
    expect(withModel.slice(-2)).toEqual(['--model', 'haiku'])
  })

  // AC2: sessionId 'abc' ou maxBudgetUsd 0 -> AdeError code 'invalid_claude_args' com a mensagem exata,
  // exitCode 2; packPath vazio segue a mesma regra de validação descrita nas decisões.
  test('buildClaudeArgs_rejects_invalid_session_id_pack_path_and_max_budget_with_ade_error', () => {
    const base = { sessionId: '11111111-2222-4333-8444-555555555555', packPath: '/p/pack.md', maxBudgetUsd: 1 }

    try {
      buildClaudeArgs({ ...base, sessionId: 'abc' })
      expect.unreachable('deveria ter lançado AdeError para sessionId inválido')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_claude_args')
      expect(adeErr.message).toBe('sessionId inválido')
      expect(adeErr.exitCode).toBe(2)
    }

    try {
      buildClaudeArgs({ ...base, maxBudgetUsd: 0 })
      expect.unreachable('deveria ter lançado AdeError para maxBudgetUsd inválido')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_claude_args')
      expect(adeErr.message).toBe('maxBudgetUsd inválido')
      expect(adeErr.exitCode).toBe(2)
    }

    try {
      buildClaudeArgs({ ...base, packPath: '' })
      expect.unreachable('deveria ter lançado AdeError para packPath inválido')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_claude_args')
      expect(adeErr.message).toBe('packPath inválido')
      expect(adeErr.exitCode).toBe(2)
    }
  })
  // Revisão: model, quando informado, tem de ser string não vazia; senão AdeError invalid_claude_args.
  test('buildClaudeArgs_rejects_non_string_or_empty_model_with_ade_error', () => {
    const base = { sessionId: '11111111-2222-4333-8444-555555555555', packPath: '/p/pack.md', maxBudgetUsd: 1 }

    for (const model of [null, 42, '']) {
      try {
        buildClaudeArgs({ ...base, model: model as unknown as string })
        expect.unreachable('deveria ter lançado AdeError para model inválido: ' + String(model))
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_claude_args')
        expect(adeErr.message).toBe('model inválido')
        expect(adeErr.exitCode).toBe(2)
      }
    }
  })
})
