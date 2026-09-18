/* eslint-disable unicorn/no-thenable */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { digest16 } from '../../src/journal/canonical.js'
import { AdeError } from '../../src/journal/errors.js'
import { loadPlan } from '../../src/engine/plan-load.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    removeTmpDir(dir)
  }
  tmpDirs = []
})

interface WritePlanDirOptions {
  plan?: Record<string, any>
  planRaw?: string
  contracts?: Record<string, any>
  contractsRaw?: Record<string, string>
  gates?: any
  gatesRaw?: string
  skipContracts?: boolean
}

function writePlanDir(overrides: WritePlanDirOptions = {}): {
  dir: string
  planPath: string
  defaultContract: Record<string, any>
} {
  const dir = makeTmpDir('plan-load-test-')
  tmpDirs.push(dir)

  const defaultPlan = {
    format_version: 1,
    id: 'plan-1',
    mission_id: 'mission-1',
    immutable_digest: '0123456789abcdef',
    authorization: {
      autonomy: 'safe',
      permitted_effects: [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['ADE-T1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 1,
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }

  const defaultContract = {
    format_version: 1,
    id: 'ADE-T1',
    title: 'Test Story',
    complexity: 'bounded',
    task: 'Test task',
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN something happens THE SYSTEM SHALL behave.',
      },
    ],
    scenarios: [
      {
        id: 'C1',
        given: 'initial state',
        when: 'action taken',
        then: 'result verified',
        evals: ['E1'],
      },
    ],
    evals: [
      {
        format_version: 1,
        kind: 'test',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    skills: [],
    roles: {
      maker: {
        family: 'claude',
        model_id: 'claude-sonnet-5',
      },
      checker_round: {
        family: 'codex',
        model_id: 'codex-1',
      },
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }

  const planPath = path.join(dir, 'plan.json')
  if (overrides.planRaw !== undefined) {
    writeFileSync(planPath, overrides.planRaw, 'utf8')
  } else {
    const planObj = overrides.plan !== undefined ? { ...defaultPlan, ...overrides.plan } : defaultPlan
    writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')
  }

  if (!overrides.skipContracts) {
    const storiesDir = path.join(dir, 'stories')
    mkdirSync(storiesDir, { recursive: true })

    if (overrides.contractsRaw) {
      for (const [storyId, raw] of Object.entries(overrides.contractsRaw)) {
        writeFileSync(path.join(storiesDir, `${storyId}.json`), raw, 'utf8')
      }
    } else if (overrides.contracts) {
      for (const [storyId, contract] of Object.entries(overrides.contracts)) {
        writeFileSync(path.join(storiesDir, `${storyId}.json`), JSON.stringify(contract, null, 2), 'utf8')
      }
    } else {
      writeFileSync(
        path.join(storiesDir, 'ADE-T1.json'),
        JSON.stringify(defaultContract, null, 2),
        'utf8',
      )
    }
  }

  if (overrides.gatesRaw !== undefined) {
    writeFileSync(path.join(dir, 'gates.json'), overrides.gatesRaw, 'utf8')
  } else if (overrides.gates !== undefined) {
    writeFileSync(path.join(dir, 'gates.json'), JSON.stringify(overrides.gates, null, 2), 'utf8')
  }

  return { dir, planPath, defaultContract }
}

describe('plan-load parity', () => {
  // CA1: Caso feliz de carga de plano e contrato com spec_revision e evals normalizados
  test('plan_loads_valid_plan_and_contracts_with_spec_revision_and_eval_argv', () => {
    const { dir, planPath, defaultContract } = writePlanDir()
    const result = loadPlan(planPath)

    expect(result.planDir).toBe(path.resolve(dir))
    expect(result.missionBudget).toEqual({
      max_usd: 1,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    })
    expect(result.gates).toEqual([])
    expect(result.stories).toHaveLength(1)

    const story = result.stories[0]
    expect(story.id).toBe('ADE-T1')
    expect(story.spec_revision).toBe(digest16(defaultContract))
    expect(story.evals).toHaveLength(1)
    expect(story.evals[0]).toEqual({
      id: 'E1',
      format_version: 1,
      kind: 'test',
      argv: ['node', 'tests/check.mjs'],
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 65536,
      evidence: ['tests/check.mjs'],
      strictness: {
        mode: 'must_fail_before',
      },
      author: 'operator',
    })
  })

  // CA1: Carga de gates.json válido e campos opcionais em mission_budget
  test('plan_loads_valid_gates_when_gates_json_present', () => {
    const validGates = [
      {
        id: 'lint',
        argv: ['node', '-e', '0'],
        when: 'always',
        expect_exit: 0,
        timeout_s: 30,
      },
    ]
    const { planPath } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 5,
          max_wall_clock_seconds: 7200,
          max_parked_units: 2,
        },
      },
      gates: validGates,
    })

    const result = loadPlan(planPath)
    expect(result.gates).toEqual(validGates)
    expect(result.missionBudget).toEqual({
      max_usd: 5,
      max_wall_clock_seconds: 7200,
      max_parked_units: 2,
    })
  })

  // CA4: Eval com caminho em cmd fora de scope_paths é recusado com eval_outside_scope (exit 4)
  test('contract_with_eval_outside_scope_paths_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/fora.test.ts'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/app.ts'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('eval_outside_scope')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('eval E1 cita caminho fora de scope_paths: tests/fora.test.ts')
    }
  })

  // CA4: Eval com caminho em evidence fora de scope_paths é recusado com eval_outside_scope (exit 4)
  test('contract_with_evidence_outside_scope_paths_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'src/check.mjs'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['tests/fora.test.ts::cenario1'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('eval_outside_scope')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('eval E1 cita caminho fora de scope_paths: tests/fora.test.ts')
    }
  })

  // Contrato ausente lança contract_missing com exit 4
  test('missing_contract_is_refused', () => {
    const { planPath } = writePlanDir({ skipContracts: true })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('contract_missing')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('contrato ausente: ADE-T1')
    }
  })

  // Arquivo gates.json inválido é recusado com gates_invalid (exit 4)
  test('invalid_gates_file_is_refused', () => {
    // JSON ilegível
    const { planPath: unreadableGatesPlan } = writePlanDir({ gatesRaw: '{' })
    try {
      loadPlan(unreadableGatesPlan)
      expect.unreachable('deveria ter falhado para JSON ilegível')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('gates_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('gates inválidos: JSON ilegível')
    }

    // Não é array
    const { planPath: notArrayGatesPlan } = writePlanDir({ gatesRaw: '{"id": "x"}' })
    try {
      loadPlan(notArrayGatesPlan)
      expect.unreachable('deveria ter falhado para gates que não é array')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('gates_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('gates inválidos: não é array')
    }

    // argv vazio
    const { planPath: emptyArgvGatesPlan } = writePlanDir({
      gates: [{ id: 'x', argv: [], when: 'always', expect_exit: 0, timeout_s: 30 }],
    })
    try {
      loadPlan(emptyArgvGatesPlan)
      expect.unreachable('deveria ter falhado para argv vazio')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('gates_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('gates inválidos: item 0: argv')
    }

    // chave inesperada
    const { planPath: extraKeyGatesPlan } = writePlanDir({
      gates: [
        { id: 'x', argv: ['node', '-e', '0'], when: 'always', expect_exit: 0, timeout_s: 30, extra: true },
      ],
    })
    try {
      loadPlan(extraKeyGatesPlan)
      expect.unreachable('deveria ter falhado para chave inesperada')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('gates_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('gates inválidos: item 0: extra')
    }

    // timeout_s inválido (< 1)
    const { planPath: invalidTimeoutGatesPlan } = writePlanDir({
      gates: [{ id: 'x', argv: ['node', '-e', '0'], when: 'always', expect_exit: 0, timeout_s: 0 }],
    })
    try {
      loadPlan(invalidTimeoutGatesPlan)
      expect.unreachable('deveria ter falhado para timeout_s < 1')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('gates_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('gates inválidos: item 0: timeout_s')
    }
  })

  // Plano ilegível lança plan_unreadable com exit 4
  test('unreadable_plan_is_refused', () => {
    const dir = makeTmpDir('plan-unreadable-')
    tmpDirs.push(dir)
    const nonExistent = path.join(dir, 'plan.json')
    try {
      loadPlan(nonExistent)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_unreadable')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('plano ilegível')
    }

    const { planPath: malformedJsonPlan } = writePlanDir({ planRaw: '{ invalid json' })
    try {
      loadPlan(malformedJsonPlan)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_unreadable')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('plano ilegível')
    }
  })

  // Contrato com schema inválido lança contract_schema_invalid com exit 4
  test('invalid_contract_schema_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          // missing title and other required fields
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('contract_schema_invalid')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('contrato inválido: ADE-T1')
    }
  })

  // CA4: Eval com arquivo na raiz fora de scope_paths é recusado com eval_outside_scope (exit 4)
  test('contract_with_eval_root_file_outside_scope_paths_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'fora.test.ts'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/app.ts'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('eval_outside_scope')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('eval E1 cita caminho fora de scope_paths: fora.test.ts')
    }
  })

  // CA4: Eval com opção contendo caminho fora de scope_paths é recusado com eval_outside_scope (exit 4)
  test('contract_with_eval_option_path_outside_scope_paths_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', '--arquivo=tests/fora.test.ts'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/app.ts'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('eval_outside_scope')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('eval E1 cita caminho fora de scope_paths: tests/fora.test.ts')
    }
  })

  // CA4: Eval com caminho com traversal ('..' escapando ou saindo do escopo) é recusado com eval_outside_scope (exit 4)
  test('contract_with_eval_traversal_outside_scope_paths_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'src/../outside.test.ts'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/app.ts'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('eval_outside_scope')
      expect(err.exitCode).toBe(4)
    }
  })

  // Contrato com surrogate isolado falha na canonicalização e é recusado com AdeError exit 4
  test('contract_with_lone_surrogate_is_refused_with_ade_error', () => {
    const { planPath } = writePlanDir({
      contractsRaw: {
        'ADE-T1': JSON.stringify({
          format_version: 1,
          id: 'ADE-T1',
          title: 'Test Story with lone surrogate \uD800',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'src/check.mjs'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/check.mjs'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        }),
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('contract_canonicalization_failed')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('contrato inválido: ADE-T1')
    }
  })

  // Contrato cujo id diverge do storyId no plano/arquivo é recusado com AdeError exit 4
  test('contract_with_mismatched_id_is_refused', () => {
    const { planPath } = writePlanDir({
      contracts: {
        'ADE-T1': {
          format_version: 1,
          id: 'ADE-T2',
          title: 'Mismatched Story',
          complexity: 'bounded',
          task: 'Test task',
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', evals: ['E1'] }],
          evals: [
            {
              format_version: 1,
              kind: 'test',
              cmd: ['node', 'src/check.mjs'],
              expect_exit: 0,
              timeout_s: 120,
              max_output_bytes: 65536,
              evidence: ['src/check.mjs'],
              strictness: { mode: 'must_fail_before' },
              author: 'operator',
            },
          ],
          skills: [],
          roles: {
            maker: { family: 'claude', model_id: 'claude-sonnet-5' },
            checker_round: { family: 'codex', model_id: 'codex-1' },
          },
          budget: { max_model_calls: 6, max_rework_rounds: 2 },
        },
      },
    })

    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('contract_id_mismatch')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('ADE-T1')
    }
  })
})
