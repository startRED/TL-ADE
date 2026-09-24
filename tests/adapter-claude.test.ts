import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { createStepRunner } from '../src/step/step.ts'
import { validate } from '../src/schema/index.ts'
import { buildClaudeArgs, CLAUDE_PROMPT } from '../src/adapters/claude/argv.ts'
import { parseClaudeOutput, parseUnitResult, parseUsage, stripAnsi } from '../src/adapters/claude/parse.ts'
import { dispatchClaude } from '../src/adapters/claude/index.ts'
import { runWorker } from '../src/runner/spawn.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')
const SCHEMA_PATH = fileURLToPath(new URL('../schemas/unit-result.schema.json', import.meta.url))
const TRANSCRIPTS_DIR = fileURLToPath(new URL('../fixtures/transcripts/claude/', import.meta.url))

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'
const FIXED_UUID = '11111111-2222-4333-8444-555555555555'

function readTranscriptStdout(name: string): string {
  return readFileSync(path.join(TRANSCRIPTS_DIR, name, 'stdout.json'), 'utf8')
}

function paidAuthorization() {
  const now = Date.now()
  return {
    authorized: true as const,
    family: 'claude' as const,
    phase: 'implementation',
    context_bytes: 1,
    weekly_percent_cap: 50,
    reservation: { calls: 1, usd: 0.25, turns: 1, family: 'claude' as const },
    quota_receipt: {
      source: 'official',
      family: 'claude',
      used_percent: 0,
      reserved_percent: 0,
      observed_at: new Date(now).toISOString(),
      weekly_reset_at: new Date(now + 86400000).toISOString(),
    },
  }
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
    expect(okUnitResult.format_version).toBe(2)
    expect(okUnitResult.state).toBe('ready_for_verification')
    expect(okUnitResult.requested_action).toBe('verify')
    expect(okUnitResult).not.toHaveProperty('passes')
    expect(okUnitResult).not.toHaveProperty('approved')
    expect(okUnitResult).not.toHaveProperty('reason')
    expect(okResult.cited).toBe(true)

    const legacyEnvelope = {
      structured_output: {
        format_version: 1,
        story_id: 'rec-legacy',
        state: 'done',
        phase: 'make',
        round: 1,
        tree_before: '0',
        tree_after: '0',
        eval_records: [],
        gate_records: [],
        passes: true,
        reason: 'gravacao',
        sources: [],
      },
    }
    const legacyResult = parseUnitResult(legacyEnvelope)
    expect(legacyResult.valid).toBe(false)
    expect(legacyResult.errors.length).toBeGreaterThan(0)

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

describe('claude adapter dispatch', () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs) {
      removeTmpDir(dir)
    }
    tmpDirs = []
  })

  function makeMissionDir(): string {
    const dir = makeTmpDir('ade-adapter-claude-')
    tmpDirs.push(dir)
    return dir
  }

  function readEvents(missionDir: string): Array<Record<string, any>> {
    return readJournal(path.join(missionDir, 'journal.jsonl')).events
  }

  // Prepara um cenário 'claude-ok' que devolve o transcript gravado ok_with_structured_output,
  // reproduzindo a convenção da CLI falsa (stdout_from resolvido dois níveis acima do cenário).
  function setupClaudeOkScenario(missionDir: string): { scenarioDir: string; packPath: string; resultFile: string } {
    const scenarioDir = path.join(missionDir, 'scenarios', 'claude-ok')
    mkdirSync(scenarioDir, { recursive: true })
    writeFileSync(
      path.join(scenarioDir, 'maker.json'),
      JSON.stringify([{ stdout_from: 'transcripts/claude/ok_with_structured_output', no_result: true }]),
    )
    const transcriptDest = path.join(missionDir, 'transcripts', 'claude', 'ok_with_structured_output')
    cpSync(path.join(TRANSCRIPTS_DIR, 'ok_with_structured_output'), transcriptDest, { recursive: true })

    const packPath = path.join(missionDir, 'pack.md')
    writeFileSync(packPath, '# pack\n')
    const resultFile = path.join(missionDir, 'result.json')

    return { scenarioDir, packPath, resultFile }
  }

  function makeRunner(missionDir: string) {
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const { step } = createStepRunner({ journal, missionDir, gitPort: null, env: {} })
    return { journal, step }
  }

  // CA1: o UUID cunhado por dispatchClaude já está gravado no step_intent do journal no instante em
  // que runWorkerImpl (e por trás dele, o spawn real) é chamado, e o argv capturado pela CLI falsa
  // traz --session-id seguido do mesmo UUID.
  test('session_id_is_preminted_and_journaled_before_spawn', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)
    const { scenarioDir, packPath, resultFile } = setupClaudeOkScenario(missionDir)

    let intentSnapshotAtSpawn: Array<Record<string, any>> | undefined
    const spyingRunWorkerImpl = async (opts: Parameters<typeof runWorker>[0]) => {
      intentSnapshotAtSpawn = readEvents(missionDir)
      return runWorker(opts)
    }

    const result = await dispatchClaude({
      step,
      unit: 'S13',
      stepId: 'S13:r1:maker',
      packPath,
      missionDir,
      missionId: 'm1',
      cwd: missionDir,
      resultFile,
      maxBudgetUsd: 0.25,
      authorization: paidAuthorization(),
      resolved: { exe: process.execPath, prefixArgs: [CLI_PATH] },
      env: { ADE_FAKE_SCENARIO: scenarioDir, ADE_FAKE_ROLE: 'maker' },
      runWorkerImpl: spyingRunWorkerImpl,
      randomUUID: () => FIXED_UUID,
    })

    expect(intentSnapshotAtSpawn).toBeDefined()
    const intentAtSpawn = intentSnapshotAtSpawn!.find(
      (ev) => ev.kind === 'step_intent' && ev.step_id === 'S13:r1:maker',
    )
    expect(intentAtSpawn).toBeTruthy()
    expect(intentAtSpawn!.session_ref).toBe(FIXED_UUID)

    const capturedArgv: string[] = JSON.parse(readFileSync(path.join(scenarioDir, 'maker-0.argv.json'), 'utf8'))
    const sessionFlagIndex = capturedArgv.indexOf('--session-id')
    expect(sessionFlagIndex).toBeGreaterThan(-1)
    expect(capturedArgv[sessionFlagIndex + 1]).toBe(FIXED_UUID)
    const budgetFlagIndex = capturedArgv.indexOf('--max-budget-usd')
    expect(budgetFlagIndex).toBeGreaterThan(-1)
    expect(capturedArgv[budgetFlagIndex + 1]).toBe('0.25')

    expect(result.session_ref).toBe(FIXED_UUID)
  })

  // 24/09: chamada interrompida e reconciliada como cobrada volta do journal como `ambiguous` sem resultado; o adaptador
  // lia session_ref de null e derrubava o ade run ao entrar na rodada seguinte.
  test('dispatchClaude_reaproveitado_ambiguo_sem_resultado_nao_lanca', async () => {
    const missionDir = makeMissionDir()
    const step = async () => ({ step_id: 'S13:r2:maker', status: 'ambiguous', result: null, reused: true })
    const { packPath, resultFile } = setupClaudeOkScenario(missionDir)
    const result = await dispatchClaude({
      step: step as any,
      unit: 'S13',
      stepId: 'S13:r2:maker',
      packPath,
      missionDir,
      missionId: 'm1',
      cwd: missionDir,
      resultFile,
      maxBudgetUsd: 0.25,
      authorization: paidAuthorization(),
      resolved: { exe: process.execPath, prefixArgs: [CLI_PATH] },
      env: {},
      randomUUID: () => FIXED_UUID,
    })
    expect(result.status).toBe('ambiguous')
    expect(result.unit_result ?? null).toBeNull()
  })

  // CA2: caso feliz completo com o transcript ok_with_structured_output -> status 'ok', unit_result
  // válido pelo schema e custo reportado (nunca inventado).
  test('dispatchClaude_resolves_ok_with_valid_unit_result_and_reported_usage', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)
    const { scenarioDir, packPath, resultFile } = setupClaudeOkScenario(missionDir)

    const result = await dispatchClaude({
      step,
      unit: 'S13',
      stepId: 'S13:r1:maker',
      packPath,
      missionDir,
      missionId: 'm1',
      cwd: missionDir,
      resultFile,
      maxBudgetUsd: 0.25,
      authorization: paidAuthorization(),
      resolved: { exe: process.execPath, prefixArgs: [CLI_PATH] },
      env: { ADE_FAKE_SCENARIO: scenarioDir, ADE_FAKE_ROLE: 'maker' },
      randomUUID: () => FIXED_UUID,
    })

    expect(result.status).toBe('ok')
    expect(result.step_id).toBe('S13:r1:maker')
    expect(result.session_ref).toBe(FIXED_UUID)
    expect(result.exit_code).toBe(0)
    expect(result.envelope_error).toBeNull()
    expect(result.valid).toBe(true)
    expect(result.cited).toBe(true)
    const unitRes = result.unit_result as Record<string, unknown>
    expect(unitRes.story_id).toBe('rec-ok')
    expect(unitRes.format_version).toBe(2)
    expect(unitRes.state).toBe('ready_for_verification')
    expect(unitRes.requested_action).toBe('verify')
    expect(unitRes).not.toHaveProperty('passes')
    expect(validate('unit-result', unitRes).valid).toBe(true)
    expect(result.usage.cost_source).toBe('reported')
    expect(result.usage.cost_usd).toBe(0.058924000000000004)

    const events = readEvents(missionDir)
    const intent = events.find((ev) => ev.kind === 'step_intent' && ev.step_id === 'S13:r1:maker')
    expect(intent!.session_ref).toBe(FIXED_UUID)
    const stepResult = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'S13:r1:maker')
    expect(stepResult!.status).toBe('ok')
  })
})
