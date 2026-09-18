import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { classifyRed, parseReporterJson } from '../src/evals/classify.js'
import { validateScenarioStrictness } from '../src/evals/strictness.js'
import { validate } from '../src/schema/index.js'

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
