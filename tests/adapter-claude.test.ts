import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import { validate } from '../src/schema/index.js'
import { buildClaudeArgs, CLAUDE_PROMPT } from '../src/adapters/claude/argv.js'
import { parseClaudeOutput, parseUnitResult, parseUsage, stripAnsi } from '../src/adapters/claude/parse.js'

const SCHEMA_PATH = fileURLToPath(new URL('../schemas/unit-result.schema.json', import.meta.url))
const TRANSCRIPTS_DIR = fileURLToPath(new URL('../fixtures/transcripts/claude/', import.meta.url))

function readTranscriptStdout(name: string): string {
  return readFileSync(path.join(TRANSCRIPTS_DIR, name, 'stdout.json'), 'utf8')
}

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

describe('claude parse', () => {
  // CA1: transcript gravado com structured_output -> parseUnitResult valid, unit_result aceito pelo
  // schema unit-result e igual ao gravado; parseUsage reporta o custo gravado (cost_source 'reported').
  // CA3: variantes com campos desconhecidos e ruído ANSI carregam o mesmo unit_result do original,
  // com error:null. CA4: JSON truncado e stdout vazio nunca lançam; devolvem envelope nulo com o
  // motivo certo.
  test('claude_adapter_parses_recorded_transcript_into_unit_result', () => {
    const okParsed = parseClaudeOutput(readTranscriptStdout('ok_with_structured_output'))
    expect(okParsed.error).toBeNull()

    const okResult = parseUnitResult(okParsed.envelope)
    expect(okResult.valid).toBe(true)
    expect(okResult.errors).toEqual([])
    const okUnitResult = okResult.unit_result as Record<string, unknown>
    expect(okUnitResult.story_id).toBe('rec-ok')
    expect(validate('unit-result', okUnitResult).valid).toBe(true)
    // sources:[] no transcript gravado -> cited nunca é true sem fontes, mesmo com resultado válido.
    expect(okResult.cited).toBe(false)

    const okUsage = parseUsage(okParsed.envelope as Record<string, unknown>)
    expect(okUsage.cost_source).toBe('reported')
    expect(okUsage.cost_usd).toBe(0.058924000000000004)
    expect(okUsage.cost_basis).toBe('list')
    expect(okUsage.models).toEqual([{ role: 'maker', model_id: 'claude-haiku-4-5-20251001' }])

    for (const variant of ['unknown_fields', 'ansi_noise']) {
      const variantParsed = parseClaudeOutput(readTranscriptStdout(variant))
      expect(variantParsed.error).toBeNull()
      const variantResult = parseUnitResult(variantParsed.envelope)
      expect(variantResult.valid).toBe(true)
      expect(variantResult.unit_result).toEqual(okUnitResult)
    }

    // ANSI cru sintético (CSI erase-line, SGR reset) some antes do parse; stripAnsi cobre a fronteira
    // usada por parseClaudeOutput.
    expect(stripAnsi('[2Khello[0m')).toBe('hello')
    expect(parseClaudeOutput('[2K{"a":1}[0m')).toEqual({ envelope: { a: 1 }, error: null })

    const truncatedParsed = parseClaudeOutput(readTranscriptStdout('truncated_json'))
    expect(truncatedParsed.envelope).toBeNull()
    expect(truncatedParsed.error).toBe('truncated_json')

    const emptyParsed = parseClaudeOutput('')
    expect(emptyParsed.envelope).toBeNull()
    expect(emptyParsed.error).toBe('empty')

    const notJsonParsed = parseClaudeOutput('no braces here')
    expect(notJsonParsed.envelope).toBeNull()
    expect(notJsonParsed.error).toBe('not_json')

    // borda: sem envelope, ou envelope sem structured_output -> nunca inventa unit_result nem cita.
    expect(parseUnitResult(null)).toEqual({
      unit_result: null,
      valid: false,
      errors: ['structured_output ausente'],
      cited: false,
    })
    expect(parseUnitResult({})).toEqual({
      unit_result: null,
      valid: false,
      errors: ['structured_output ausente'],
      cited: false,
    })

    // borda: structured_output null ou primitivo -> resultado inválido, sem lançar (nunca devolve
    // um unit_result que não seja object | null).
    expect(parseUnitResult({ structured_output: null })).toEqual({
      unit_result: null,
      valid: false,
      errors: ['structured_output ausente'],
      cited: false,
    })
    expect(parseUnitResult({ structured_output: 'texto' })).toEqual({
      unit_result: null,
      valid: false,
      errors: ['structured_output ausente'],
      cited: false,
    })
  })
})
