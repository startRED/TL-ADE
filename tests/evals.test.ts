import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { classifyGreen, classifyRed, parseReporterJson } from '../src/evals/classify.js'
import { createEvalRunner } from '../src/evals/eval-runner.js'
import { validateScenarioStrictness } from '../src/evals/strictness.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { validate } from '../src/schema/index.js'
import { createStepRunner } from '../src/step/step.js'

describe('evals classification and strictness', () => {
  // CA1: Dado um stdout de reporter com {"numTotalTests":0,"numPassedTests":0,"numFailedTests":0}
  // e saída 1, quando classifyRed roda, então red_reason é 'missing_target' e num_total_tests é 0.
  test('missing_target_zero_tests_is_never_green', () => {
    // Tolerância a ruídos antes e depois no parseReporterJson
    const rawStdout =
      'ignored noise before\n{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0}\nignored noise after'
    const report = parseReporterJson(rawStdout)
    expect(report).toEqual({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
    })

    // Caso inválido de reporter
    expect(parseReporterJson('invalid json string')).toBeNull()
    expect(parseReporterJson('{"numPassedTests": 1}')).toBeNull()
    expect(parseReporterJson('{"numTotalTests": 0}')).toBeNull()
    expect(parseReporterJson('{"numTotalTests": 1, "numPassedTests": 1}')).toBeNull()
    expect(parseReporterJson('{"numTotalTests": 1, "numFailedTests": 1}')).toBeNull()

    const result = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: rawStdout,
      stderr: '',
      report,
    })

    expect(result).toEqual({
      red_reason: 'missing_target',
      num_total_tests: 0,
    })

    // Timeout gera 'environment'
    const timedOutResult = classifyRed({
      exitCode: null,
      expectExit: 0,
      timedOut: true,
      stdout: rawStdout,
      stderr: '',
      report,
    })
    expect(timedOutResult).toEqual({
      red_reason: 'environment',
      num_total_tests: 0,
    })

    // Report ausente gera 'environment'
    const nullReportResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: 'not json',
      stderr: 'some error',
      report: null,
    })
    expect(nullReportResult).toEqual({
      red_reason: 'environment',
      num_total_tests: null,
    })

    // Relatório incompleto gera 'environment'
    const incompleteReportResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: '{"numTotalTests":0}',
      stderr: '',
      report: parseReporterJson('{"numTotalTests":0}'),
    })
    expect(incompleteReportResult).toEqual({
      red_reason: 'environment',
      num_total_tests: null,
    })

    const directIncompleteResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      report: { numTotalTests: 0 } as any,
    })
    expect(directIncompleteResult).toEqual({
      red_reason: 'environment',
      num_total_tests: null,
    })

    // Execução com sucesso (exitCode === expectExit) gera red_reason: null
    const successResult = classifyRed({
      exitCode: 0,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      report: {
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
      },
    })
    expect(successResult).toEqual({
      red_reason: null,
      num_total_tests: 1,
    })

    // Falha por assertion legítima
    const assertionResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      report: {
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
      },
    })
    expect(assertionResult).toEqual({
      red_reason: 'assertion',
      num_total_tests: 1,
    })
  })

  // CA2: Dado um stderr com SyntaxError: Unexpected token e um relatório com numTotalTests:0,
  // quando classifyRed roda, então red_reason é 'missing_target' (a ordem de precedência manda),
  // e com numTotalTests:2 e o mesmo stderr o resultado é 'compile_error'.
  test('compile_error_does_not_count_as_red', () => {
    const stderr = 'SyntaxError: Unexpected token'

    // Precedência estrita: numTotalTests === 0 antes de compile_error
    const zeroTestsResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr,
      report: {
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
      },
    })
    expect(zeroTestsResult).toEqual({
      red_reason: 'missing_target',
      num_total_tests: 0,
    })

    // Com testes > 0 e erro de sintaxe
    const compileErrorResult = classifyRed({
      exitCode: 1,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr,
      report: {
        numTotalTests: 2,
        numPassedTests: 0,
        numFailedTests: 0,
      },
    })
    expect(compileErrorResult).toEqual({
      red_reason: 'compile_error',
      num_total_tests: 2,
    })

    // Outras assinaturas de erro de compilação
    for (const phrase of [
      'Transform failed with 1 error',
      'Failed to load url /src/app.js',
      'Cannot find module ./missing',
      'TS2304: Cannot find name foo',
    ]) {
      const matchRes = classifyRed({
        exitCode: 1,
        expectExit: 0,
        timedOut: false,
        stdout: phrase,
        stderr: '',
        report: {
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 0,
        },
      })
      expect(matchRes).toEqual({
        red_reason: 'compile_error',
        num_total_tests: 1,
      })
    }
  })

  // CA3: Dado um cenário {id:'C1', evals:[{kind:'test', strictness:{mode:'additive'}}]},
  // quando validateScenarioStrictness roda, então devolve {ok:false, code:'additive_without_companion', scenario:'C1'};
  // com um segundo eval kind:'negative' no mesmo cenário devolve {ok:true, code:null}.
  test('additive_without_negative_or_mutate_is_refused', () => {
    // Sem companheiro: recusa com código additive_without_companion
    const withoutCompanion = validateScenarioStrictness({
      id: 'C1',
      evals: [{ kind: 'test', strictness: { mode: 'additive' } }],
    })
    expect(withoutCompanion).toEqual({
      ok: false,
      code: 'additive_without_companion',
      scenario: 'C1',
    })

    // Com companheiro kind === 'negative': aceito
    const withNegativeCompanion = validateScenarioStrictness({
      id: 'C1',
      evals: [
        { kind: 'test', strictness: { mode: 'additive' } },
        { kind: 'negative', strictness: { mode: 'must_fail_before' } },
      ],
    })
    expect(withNegativeCompanion).toEqual({
      ok: true,
      code: null,
      scenario: 'C1',
    })

    // Com companheiro strictness.mode === 'mutate': aceito
    const withMutateCompanion = validateScenarioStrictness({
      id: 'C1',
      evals: [
        { kind: 'test', strictness: { mode: 'additive' } },
        { kind: 'test', strictness: { mode: 'mutate' } },
      ],
    })
    expect(withMutateCompanion).toEqual({
      ok: true,
      code: null,
      scenario: 'C1',
    })

    // Cenário sem nenhum eval aditivo: válido
    const noAdditive = validateScenarioStrictness({
      id: 'C1',
      evals: [{ kind: 'test', strictness: { mode: 'must_fail_before' } }],
    })
    expect(noAdditive).toEqual({
      ok: true,
      code: null,
      scenario: 'C1',
    })

    // Cenário com evals vazios: válido
    const emptyEvals = validateScenarioStrictness({
      id: 'C1',
      evals: [],
    })
    expect(emptyEvals).toEqual({
      ok: true,
      code: null,
      scenario: 'C1',
    })
  })

  // CA4: Dado um eval com strictness.mode:'strict', quando validado por validate('eval', doc)
  // de src/schema/index.js, então é recusado com valid:false, e com mode:'must_fail_before' é aceito.
  test('strictness_mode_enum_is_closed', () => {
    const validEval = JSON.parse(
      readFileSync(new URL('../fixtures/schemas/eval/valid.json', import.meta.url), 'utf8')
    )

    // mode: 'strict' não é um modo aceito no enum fechado
    const invalidMode = {
      ...validEval,
      strictness: { mode: 'strict' },
    }
    const invalidResult = validate('eval', invalidMode)
    expect(invalidResult.valid).toBe(false)

    // Modos permitidos: must_fail_before, additive, mutate
    for (const allowedMode of ['must_fail_before', 'additive', 'mutate']) {
      const allowedEval = {
        ...validEval,
        strictness: { mode: allowedMode },
      }
      const allowedResult = validate('eval', allowedEval)
      expect(allowedResult.valid).toBe(true)
    }
  })
})

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora erros de limpeza no teardown
    }
  }
  tmpDirs = []
})

function createMiniProject(dir: string, sumImpl: string) {
  writeFileSync(
    path.join(dir, 'vitest.config.mjs'),
    // pool threads: o Vitest aninhado não forka processo extra e pesa menos na suíte em paralelo
    'export default { test: { include: ["*.test.js"], pool: "threads", fileParallelism: false } }\n',
    'utf8'
  )
  writeFileSync(path.join(dir, 'sum.js'), sumImpl, 'utf8')
  writeFileSync(
    path.join(dir, 'sum.test.js'),
    'import { expect, test } from "vitest"\nimport { sum } from "./sum.js"\ntest("sums two numbers", () => { expect(sum(1, 2)).toBe(3) })\n',
    'utf8'
  )
}

describe('eval runner phase red execution and strictness', () => {
  const vitestBin = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

  // CA1: Dado um mini-projeto Vitest em tmpdir cujo teste sums two numbers já passa,
  // quando runEval({phase:'red', ...}) roda com strictness.mode:'must_fail_before',
  // então o EvalRecord traz verdict:'eval_born_green', red_reason:null e num_total_tests:1,
  // e o journal tem um step_result de effect_class:'eval_run'.
  test('eval_born_green_is_rejected', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    createMiniProject(fixtureDir, 'export function sum(a, b) { return a + b }\n')

    const tree = 'tree-green-123'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.red',
      argv: [
        'node',
        vitestBin,
        'run',
        '--root',
        fixtureDir,
        '--config',
        path.join(fixtureDir, 'vitest.config.mjs'),
        '--reporter=json',
        '-t',
        'sums two numbers',
      ],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(record.verdict).toBe('eval_born_green')
    expect(record.red_reason).toBeNull()
    expect(record.num_total_tests).toBe(1)
    expect(record.eval_id).toBe('sum.red')
    expect(record.phase).toBe('red')
    expect(record.tree).toBe(tree)
    expect(record.exit_code).toBe(0)

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const stepResult = events.find((e) => e.kind === 'step_result' && e.effect_class === 'eval_run')
    expect(stepResult).toBeDefined()
    expect(stepResult?.status).toBe('ok')
  })

  // CA2: Dado o mesmo mini-projeto com o teste falhando por asserção,
  // quando runEval({phase:'red', ...}) roda, então o EvalRecord traz verdict:'red_valid',
  // red_reason:'assertion', exit_code diferente de expect_exit e raw_ref art:evals/<id>/red.
  test('red_from_assertion_is_valid', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    createMiniProject(fixtureDir, 'export function sum(a, b) { return 0 }\n')

    const tree = 'tree-red-456'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.red',
      argv: [
        'node',
        vitestBin,
        'run',
        '--root',
        fixtureDir,
        '--config',
        path.join(fixtureDir, 'vitest.config.mjs'),
        '--reporter=json',
        '-t',
        'sums two numbers',
      ],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(record.verdict).toBe('red_valid')
    expect(record.red_reason).toBe('assertion')
    expect(record.exit_code).toBe(1)
    expect(record.exit_code).not.toBe(evalDef.expect_exit)
    expect(record.raw_ref).toBe('art:evals/sum.red/red')
    expect(record.num_total_tests).toBe(1)
  })

  // CA3: Dado um gitPort cujo worktreeTree() devolve uma árvore diferente da tree passada,
  // quando runEval roda, então devolve verdict:'refused' com warnings:['worktree_tree_mismatch'],
  // exit_code:null e raw_ref:null, e nenhum processo filho é executado.
  test('eval_refuses_when_worktree_tree_differs', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    createMiniProject(fixtureDir, 'export function sum(a, b) { return a + b }\n')

    const tree = 'tree-expected-789'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => 'outra',
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.red',
      argv: [
        'node',
        vitestBin,
        'run',
        '--root',
        fixtureDir,
        '--config',
        path.join(fixtureDir, 'vitest.config.mjs'),
        '--reporter=json',
        '-t',
        'sums two numbers',
      ],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['worktree_tree_mismatch'])
    expect(record.exit_code).toBeNull()
    expect(record.raw_ref).toBeNull()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const evalIntents = events.filter((e) => e.kind === 'step_intent' && String(e.step_id || '').startsWith('eval:'))
    expect(evalIntents).toHaveLength(0)
  })

  // Caso adverso: eval.argv[0] não é node nem caminho absoluto .exe
  test('eval_command_must_start_with_node', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-cmd0'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'bad.cmd0',
      argv: ['npx', 'vitest'],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    await expect(
      runner.runEval({
        eval: evalDef,
        phase: 'red',
        tree,
        unit: 'u1',
      })
    ).rejects.toThrow(new TypeError('argv inválido: cmd[0] precisa ser node'))
  })

  // Caso de rebaixamento: qualquer outro red_reason (ex: compile_error) rebaixa para additive com aviso
  test('downgraded_additive_when_red_reason_is_not_assertion', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    // Reporter falso em processo node puro: o suite não carrega (SyntaxError) e o Vitest reporta
    // zero testes, o que classifica missing_target; dispensa um Vitest aninhado a mais na suíte
    const fakeReporter =
      'process.stderr.write("SyntaxError: Unexpected token\\n");' +
      'process.stdout.write(JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 }));' +
      'process.exitCode = 1'

    const tree = 'tree-compile-error'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.compile',
      argv: ['node', '-e', fakeReporter],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(record.verdict).toBe('downgraded_additive')
    expect(record.red_reason).toBe('missing_target')
    expect(record.warnings).toEqual(['red_reason=missing_target rebaixado para additive'])
  })

  // Validação estrita: campos obrigatórios de EvalDef e enum de strictness.mode
  test('eval_def_missing_fields_or_invalid_strictness_are_rejected', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-validation'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const validEval = {
      id: 'sum.val',
      argv: ['node', 'test.js'],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    // eval ausente
    await expect(
      runner.runEval({ eval: null as any, phase: 'red', tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)

    // eval.id ausente
    await expect(
      runner.runEval({ eval: { ...validEval, id: '' }, phase: 'red', tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)

    // eval.argv ausente
    await expect(
      runner.runEval({ eval: { ...validEval, argv: [] }, phase: 'red', tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)

    // eval.kind ausente
    await expect(
      runner.runEval({ eval: { ...validEval, kind: '' }, phase: 'red', tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)

    // eval.expect_exit ausente/inválido
    await expect(
      runner.runEval({
        eval: { ...validEval, expect_exit: undefined as any },
        phase: 'red',
        tree,
        unit: 'u1',
      })
    ).rejects.toThrow(TypeError)

    // eval.timeout_s ausente/inválido
    await expect(
      runner.runEval({ eval: { ...validEval, timeout_s: 0 }, phase: 'red', tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)

    // eval.max_output_bytes ausente/inválido
    await expect(
      runner.runEval({
        eval: { ...validEval, max_output_bytes: 0 },
        phase: 'red',
        tree,
        unit: 'u1',
      })
    ).rejects.toThrow(TypeError)

    // eval.strictness ausente
    await expect(
      runner.runEval({
        eval: { ...validEval, strictness: undefined as any },
        phase: 'red',
        tree,
        unit: 'u1',
      })
    ).rejects.toThrow(TypeError)

    // eval.strictness.mode inválido
    await expect(
      runner.runEval({
        eval: { ...validEval, strictness: { mode: 'unknown' as any } },
        phase: 'red',
        tree,
        unit: 'u1',
      })
    ).rejects.toThrow(TypeError)

    // phase inválida
    await expect(
      runner.runEval({ eval: validEval, phase: 'invalid' as any, tree, unit: 'u1' })
    ).rejects.toThrow(TypeError)
  })

  // CA4: Dado um eval sem reporter Vitest (argv roda 'node -e' puro), quando runEval({phase:'green'})
  // roda, então o EvalRecord traz verdict:'green_failed', red_reason:'environment', exit_code:0 e
  // raw_ref:'art:evals/sum.scope/green', e o journal tem exatamente 1 step_intent.
  test('green_phase_without_reporter_is_green_failed', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-out-of-scope'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.scope',
      argv: ['node', '-e', 'process.exitCode = 0'],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const green = await runner.runEval({ eval: evalDef, phase: 'green', tree, unit: 'u1' })
    expect(green.verdict).toBe('green_failed')
    expect(green.red_reason).toBe('environment')
    expect(green.exit_code).toBe(0)
    expect(green.raw_ref).toBe('art:evals/sum.scope/green')

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    expect(events.filter((e) => e.kind === 'step_intent')).toHaveLength(1)
  })

  // Teto do extrato por kind: o EvalRecord leva stdout/stderr cortados (com marca), o bruto vai inteiro ao artefato
  test('eval_excerpts_are_capped_by_kind_and_raw_is_complete', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-big-output'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const noisy =
      'process.stdout.write("é".repeat(10000));' +
      'process.stderr.write("x".repeat(9000));' +
      'process.exitCode = 1'

    const record = await runner.runEval({
      eval: {
        id: 'big.out',
        argv: ['node', '-e', noisy],
        kind: 'test',
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 8192,
        strictness: { mode: 'must_fail_before' as const },
      },
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(Buffer.byteLength(record.stdout_excerpt, 'utf8')).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(record.stderr_excerpt, 'utf8')).toBeLessThanOrEqual(8192)
    expect(record.stdout_excerpt).toContain('[...cortado:')
    expect(record.stderr_excerpt).toContain('[...cortado:')
    expect(record.stdout_excerpt).not.toContain('\uFFFD')

    const raw = readFileSync(path.join(missionDir, 'artifacts', 'evals', 'big.out', 'red.log'), 'utf8')
    expect(raw).toContain('é'.repeat(10000))
    expect(raw).toContain('x'.repeat(9000))
  })
})

describe('eval runner applies scenario strictness validation', () => {
  // Reporter falso em processo node puro: um teste que passa (nasce verde), sem Vitest aninhado
  const greenReporter =
    'process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }));' +
    'process.exitCode = 0'

  function setup(tree: string) {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }
    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })
    return { missionDir, runner }
  }

  function evalWithMode(id: string, mode: 'must_fail_before' | 'additive' | 'mutate') {
    return {
      id,
      argv: ['node', '-e', greenReporter],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode },
    }
  }

  function stepIntents(missionDir: string) {
    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    return events.filter((e) => e.kind === 'step_intent')
  }

  // CA2: Dado o mesmo eval additive num cenário sem eval negative nem mutate,
  // quando runEval roda, então o record traz verdict:'refused' e
  // warnings:['additive sem eval negative ou mutate no mesmo cenário'].
  test('additive_without_companion_is_refused', async () => {
    const tree = 'tree-additive-alone'
    const { missionDir, runner } = setup(tree)
    const evalDef = evalWithMode('sum.add', 'additive')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: {
        id: 'C2',
        evals: [{ kind: 'test', strictness: { mode: 'additive' } }],
      },
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['additive sem eval negative ou mutate no mesmo cenário'])
    expect(record.strictness_mode).toBe('additive')
    expect(record.exit_code).toBeNull()
    expect(record.raw_ref).toBeNull()
    expect(record.num_total_tests).toBeNull()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const stepResult = events.find((e) => e.kind === 'step_result' && e.effect_class === 'eval_run')
    expect(stepResult?.status).toBe('ok')
  })

  // Dado um eval additive sem scenario informado, o cenário efetivo contém apenas o próprio eval,
  // sendo recusado sem companheiro válido ('negative' ou 'mutate').
  test('additive_without_scenario_is_refused', async () => {
    const tree = 'tree-additive-no-scenario'
    const { missionDir, runner } = setup(tree)
    const evalDef = evalWithMode('sum.add', 'additive')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['additive sem eval negative ou mutate no mesmo cenário'])
    expect(record.strictness_mode).toBe('additive')
    expect(record.exit_code).toBeNull()
    expect(record.raw_ref).toBeNull()
    expect(record.num_total_tests).toBeNull()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const stepResult = events.find((e) => e.kind === 'step_result' && e.effect_class === 'eval_run')
    expect(stepResult?.status).toBe('ok')
  })

  // CA1: Dado um eval additive num cenário com um eval companheiro kind:'negative',
  // quando runEval({phase:'red', ...}) roda, então o record traz verdict:'additive_warning',
  // exit_code:null, raw_ref:null e warnings:['additive: mudança puramente aditiva, sem prova vermelha'],
  // nenhum processo filho é executado e o journal registra um step_result de eval_run.
  test('additive_strictness_records_warning_and_proceeds', async () => {
    const tree = 'tree-additive-ok'
    const { missionDir, runner } = setup(tree)
    const evalDef = evalWithMode('sum.add', 'additive')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: {
        id: 'C2',
        evals: [
          { kind: 'test', strictness: { mode: 'additive' } },
          { kind: 'negative', strictness: { mode: 'must_fail_before' } },
        ],
      },
    })

    expect(record.verdict).toBe('additive_warning')
    expect(record.warnings).toEqual(['additive: mudança puramente aditiva, sem prova vermelha'])
    expect(record.strictness_mode).toBe('additive')
    expect(record.exit_code).toBeNull()
    expect(record.raw_ref).toBeNull()
    expect(record.num_total_tests).toBeNull()
    expect(record.red_reason).toBeNull()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const stepResult = events.find((e) => e.kind === 'step_result' && e.effect_class === 'eval_run')
    expect(stepResult?.status).toBe('ok')
  })

  // Borda: a validação é do cenário inteiro e vem antes de decidir; um cenário com additive órfão
  // recusa também o eval must_fail_before que pertence a ele
  test('invalid_scenario_refuses_must_fail_before_eval_before_running', async () => {
    const tree = 'tree-scenario-invalid'
    const { missionDir, runner } = setup(tree)
    const evalDef = evalWithMode('sum.strict', 'must_fail_before')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: {
        id: 'C3',
        evals: [evalDef, { kind: 'test', strictness: { mode: 'additive' } }],
      },
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['additive_without_companion'])
    expect(record.exit_code).toBeNull()
    expect(stepIntents(missionDir)).toHaveLength(0)
  })

  // Achado: mutate não pode rodar pela lógica de must_fail_before (daria eval_born_green);
  // sem o Checker que comenta a guarda, o slice 1 só registra a recusa, sem processo
  test('mutate_eval_is_not_run_as_must_fail_before', async () => {
    const tree = 'tree-mutate'
    const { missionDir, runner } = setup(tree)
    const evalDef = evalWithMode('sum.mutate', 'mutate')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: { id: 'C4', evals: [evalDef] },
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['strictness_mutate_not_supported'])
    expect(record.strictness_mode).toBe('mutate')
    expect(record.exit_code).toBeNull()
    expect(stepIntents(missionDir)).toHaveLength(0)
  })

  // Borda: o eval executado pertence ao próprio cenário mesmo quando scenario.evals não o lista;
  // um additive fora da lista entra na validação e fica sem companheiro, sem processo nem step
  test('executed_eval_missing_from_scenario_is_validated_as_member', async () => {
    const tree = 'tree-scenario-missing-member'
    const { runner } = setup(tree)
    const evalDef = evalWithMode('sum.add', 'additive')

    const record = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: {
        id: 'C5',
        evals: [{ kind: 'test', strictness: { mode: 'must_fail_before' } }],
      },
    })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['additive sem eval negative ou mutate no mesmo cenário'])
    expect(record.exit_code).toBeNull()
    expect(record.raw_ref).toBeNull()

    // Com companheiro negative na lista, o mesmo eval ausente dela prossegue como additive
    const withCompanion = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: {
        id: 'C5',
        evals: [{ kind: 'negative', strictness: { mode: 'must_fail_before' } }],
      },
    })

    expect(withCompanion.verdict).toBe('additive_warning')
    expect(withCompanion.warnings).toEqual(['additive: mudança puramente aditiva, sem prova vermelha'])
    expect(withCompanion.exit_code).toBeNull()
  })

  // Achado: kind entra no input durável do step; mudar test (8192) para git (4096) na mesma
  // árvore reexecuta e aplica o teto novo em vez de servir o extrato antigo do cache
  test('changed_kind_is_not_served_from_cache', async () => {
    const tree = 'tree-kind-change'
    const { missionDir, runner } = setup(tree)
    const noisy = 'process.stdout.write("y".repeat(6000)); process.exitCode = 1'
    const base = {
      id: 'kind.change',
      argv: ['node', '-e', noisy],
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const asTest = await runner.runEval({ eval: { ...base, kind: 'test' }, phase: 'red', tree, unit: 'u1' })
    expect(asTest.stdout_excerpt).toBe('y'.repeat(6000))

    const asGit = await runner.runEval({ eval: { ...base, kind: 'git' }, phase: 'red', tree, unit: 'u1' })
    expect(asGit.stdout_excerpt).toBe('y'.repeat(6000))
    expect(stepIntents(missionDir)).toHaveLength(1)
  })

  // CA3: Dado um eval must_fail_before já executado sobre a árvore T,
  // quando o mesmo eval roda de novo sobre T com o scenario alterado,
  // então o eval é executado outra vez (o contador de execuções do fixture vai a 2)
  // em vez de ser servido do cache.
  test('changed_scenario_is_not_served_from_cache', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-scenario-cache'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const counterFile = path.join(fixtureDir, 'counter.txt')
    writeFileSync(counterFile, '0', 'utf8')

    const counterPathJson = JSON.stringify(counterFile)
    const incScript =
      `const fs = require('fs');` +
      `const c = parseInt(fs.readFileSync(${counterPathJson}, 'utf8'), 10) + 1;` +
      `fs.writeFileSync(${counterPathJson}, String(c), 'utf8');` +
      `process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1 }));` +
      `process.exitCode = 1;`

    const evalDef = {
      id: 'scenario.cache',
      argv: ['node', '-e', incScript],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'must_fail_before' as const },
    }

    const scenarioC3 = {
      id: 'C3',
      evals: [{ kind: 'test', strictness: { mode: 'must_fail_before' as const } }],
    }
    const scenarioC4 = {
      id: 'C4',
      evals: [{ kind: 'test', strictness: { mode: 'must_fail_before' as const } }],
    }

    // Primeira execução sobre T com scenario C3 -> contador vai a 1
    const first = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: scenarioC3,
    })
    expect(first.verdict).toBe('red_valid')
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    // Repetição sobre T com o mesmo scenario C3 -> permanece 1 (servido do cache)
    const second = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: scenarioC3,
    })
    expect(second.verdict).toBe('red_valid')
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    // Execução sobre T com scenario alterado (C4) -> contador vai a 2 (não servido do cache)
    const third = await runner.runEval({
      eval: evalDef,
      phase: 'red',
      tree,
      unit: 'u1',
      scenario: scenarioC4,
    })
    expect(third.verdict).toBe('red_valid')
    expect(readFileSync(counterFile, 'utf8')).toBe('2')
  })
})

describe('skipped tests are not executed tests', () => {
  const vitestBin = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

  // CA1: um relatório onde o único teste é pulado (numPendingTests:1) não tem nenhum teste
  // executado, então classifyRed devolve missing_target com num_total_tests:0.
  // CA4: um relatório com dois testes onde um é pulado ainda tem um teste executado,
  // então classifyRed não rebaixa para missing_target e num_total_tests desconta o pulado.
  test('skipped_tests_are_not_executed_tests', () => {
    const allSkippedResult = classifyRed({
      exitCode: 0,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      report: {
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 1,
      },
    })
    expect(allSkippedResult).toEqual({
      red_reason: 'missing_target',
      num_total_tests: 0,
    })

    const partiallySkippedResult = classifyRed({
      exitCode: 0,
      expectExit: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      report: {
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 1,
      },
    })
    expect(partiallySkippedResult).toEqual({
      red_reason: null,
      num_total_tests: 1,
    })
  })

  // CA2: parseReporterJson copia numPendingTests e numTodoTests quando presentes e numéricos;
  // quando um desses campos está presente mas não é número, o relatório inteiro é inválido (null).
  test('reporter_keeps_pending_and_todo_counts', () => {
    const withCounts = parseReporterJson(
      '{"numTotalTests":1,"numPassedTests":0,"numFailedTests":0,"numPendingTests":1,"numTodoTests":0}'
    )
    expect(withCounts).toEqual({
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
    })

    const withInvalidPending = parseReporterJson(
      '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"numPendingTests":"x"}'
    )
    expect(withInvalidPending).toBeNull()
  })

  // CA3: um filtro -t sem correspondência faz o Vitest aninhado reportar o único teste como
  // pendente; o eval não pode nascer verde nem valer como red_valid com zero testes executados,
  // então é rebaixado para additive com o mesmo aviso já usado para outros red_reason.
  test(
    'missing_target_downgrades_instead_of_passing',
    async () => {
      const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
      const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
      tmpDirs.push(fixtureDir, missionDir)

      createMiniProject(fixtureDir, 'export function sum(a, b) { return a + b }\n')

      const tree = 'tree-missing-target'
      const gitPort = {
        worktreeDir: fixtureDir,
        worktreeTree: async () => tree,
      }

      const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
      const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
      const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

      const evalDef = {
        id: 'sum.missing',
        argv: [
          'node',
          vitestBin,
          'run',
          '--root',
          fixtureDir,
          '--config',
          path.join(fixtureDir, 'vitest.config.mjs'),
          '--reporter=json',
          '-t',
          'nome que não existe',
        ],
        kind: 'test',
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 8192,
        strictness: { mode: 'must_fail_before' as const },
      }

      const record = await runner.runEval({
        eval: evalDef,
        phase: 'red',
        tree,
        unit: 'u1',
      })

      expect(record.red_reason).toBe('missing_target')
      expect(record.num_total_tests).toBe(0)
      expect(record.verdict).toBe('downgraded_additive')
      expect(record.warnings).toEqual(['red_reason=missing_target rebaixado para additive'])
    },
    60_000
  )
})

describe('eval runner phase green', () => {
  const vitestBin = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')

  // CA1: Dado o mini-projeto Vitest com soma correta, quando runEval({phase:'green'}) roda com
  // '-t','sums two numbers', então o EvalRecord traz verdict 'green', red_reason null,
  // num_total_tests 1 e raw_ref 'art:evals/sum.green/green', e o journal tem um step_result
  // com effect_class 'eval_run'.
  test(
    'green_phase_passes_real_test',
    async () => {
      const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
      const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
      tmpDirs.push(fixtureDir, missionDir)

      createMiniProject(fixtureDir, 'export function sum(a, b) { return a + b }\n')

      const tree = 'tree-green-pass'
      const gitPort = {
        worktreeDir: fixtureDir,
        worktreeTree: async () => tree,
      }

      const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
      const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
      const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

      const evalDef = {
        id: 'sum.green',
        argv: [
          'node',
          vitestBin,
          'run',
          '--root',
          fixtureDir,
          '--config',
          path.join(fixtureDir, 'vitest.config.mjs'),
          '--reporter=json',
          '-t',
          'sums two numbers',
        ],
        kind: 'test',
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 8192,
        strictness: { mode: 'must_fail_before' as const },
      }

      const record = await runner.runEval({
        eval: evalDef,
        phase: 'green',
        tree,
        unit: 'u1',
      })

      expect(record.verdict).toBe('green')
      expect(record.red_reason).toBeNull()
      expect(record.num_total_tests).toBe(1)
      expect(record.raw_ref).toBe('art:evals/sum.green/green')

      const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
      const stepResult = events.find((e) => e.kind === 'step_result' && e.effect_class === 'eval_run')
      expect(stepResult).toBeDefined()
      expect(stepResult?.status).toBe('ok')
    },
    60_000
  )

  // CA2: Dado o mesmo mini-projeto, quando runEval({phase:'green'}) roda com
  // '-t','nome que não existe', então o EvalRecord traz verdict 'refused',
  // red_reason 'missing_target', num_total_tests 0 e warnings ['green_missing_target'].
  test(
    'green_phase_refuses_missing_target',
    async () => {
      const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
      const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
      tmpDirs.push(fixtureDir, missionDir)

      createMiniProject(fixtureDir, 'export function sum(a, b) { return a + b }\n')

      const tree = 'tree-green-missing'
      const gitPort = {
        worktreeDir: fixtureDir,
        worktreeTree: async () => tree,
      }

      const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
      const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
      const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

      const evalDef = {
        id: 'sum.green.missing',
        argv: [
          'node',
          vitestBin,
          'run',
          '--root',
          fixtureDir,
          '--config',
          path.join(fixtureDir, 'vitest.config.mjs'),
          '--reporter=json',
          '-t',
          'nome que não existe',
        ],
        kind: 'test',
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 8192,
        strictness: { mode: 'must_fail_before' as const },
      }

      const record = await runner.runEval({
        eval: evalDef,
        phase: 'green',
        tree,
        unit: 'u1',
      })

      expect(record.verdict).toBe('refused')
      expect(record.red_reason).toBe('missing_target')
      expect(record.num_total_tests).toBe(0)
      expect(record.warnings).toEqual(['green_missing_target'])
    },
    60_000
  )

  // CA3: classifyGreen mapeia red_reason -> verdict/warnings sem rodar processo nenhum.
  test('classify_green_maps_red_reasons', () => {
    expect(classifyGreen({ red_reason: null })).toEqual({ verdict: 'green', warnings: [] })
    expect(classifyGreen({ red_reason: 'missing_target' })).toEqual({
      verdict: 'refused',
      warnings: ['green_missing_target'],
    })
    expect(classifyGreen({ red_reason: 'assertion' })).toEqual({
      verdict: 'green_failed',
      warnings: ['red_reason=assertion'],
    })
    expect(classifyGreen({ red_reason: 'compile_error' })).toEqual({
      verdict: 'green_failed',
      warnings: ['red_reason=compile_error'],
    })
  })

  // Decisão do plano: a fase verde roda em todos os modos de strictness exceto mutate e não tem
  // o atalho additive (que é regra da fase vermelha) — um additive sem cenário roda de verdade.
  test('green_phase_additive_runs_without_shortcut', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-green-additive'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const greenReporter =
      'process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }));' +
      'process.exitCode = 0'

    const evalDef = {
      id: 'sum.green.additive',
      argv: ['node', '-e', greenReporter],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'additive' as const },
    }

    const record = await runner.runEval({ eval: evalDef, phase: 'green', tree, unit: 'u1' })

    expect(record.verdict).toBe('green')
    expect(record.red_reason).toBeNull()
    expect(record.raw_ref).toBe('art:evals/sum.green.additive/green')
  })

  // Decisão do plano: mutate continua a única recusa nas duas fases, sem tocar no processo.
  test('green_phase_refuses_mutate_without_running', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'))
    const missionDir = mkdtempSync(path.join(os.tmpdir(), 'eval-mission-'))
    tmpDirs.push(fixtureDir, missionDir)

    const tree = 'tree-green-mutate'
    const gitPort = {
      worktreeDir: fixtureDir,
      worktreeTree: async () => tree,
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    const { step } = createStepRunner({ journal, missionDir, gitPort: gitPort as any, env: {} })
    const runner = createEvalRunner({ step, missionDir, gitPort: gitPort as any })

    const evalDef = {
      id: 'sum.green.mutate',
      argv: ['node', '-e', 'process.exitCode = 0'],
      kind: 'test',
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 8192,
      strictness: { mode: 'mutate' as const },
    }

    const record = await runner.runEval({ eval: evalDef, phase: 'green', tree, unit: 'u1' })

    expect(record.verdict).toBe('refused')
    expect(record.warnings).toEqual(['strictness_mutate_not_supported'])
    expect(record.raw_ref).toBeNull()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    expect(events.filter((e) => e.kind === 'step_intent')).toHaveLength(0)
  })
})
