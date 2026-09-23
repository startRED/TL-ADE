import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { digest16 } from '../../src/journal/canonical.ts'
import { AdeError } from '../../src/journal/errors.ts'
import { defaultStoryBudget, loadPlan } from '../../src/engine/plan-load.ts'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.ts'

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
    format_version: 2,
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
    format_version: 2,
    id: 'ADE-T1',
    title: 'Test Story',
    complexity: 'bounded',
    task: 'Test task',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: [],
    },
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
        verifiers: ['E1'],
        evals: ['E1'],
      },
    ],
    verifiers: [
      {
        id: 'E1',
        format_version: 1,
        kind: 'script',
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
    evals: [
      {
        format_version: 1,
        kind: 'script',
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
        let fullContract = contract
        if (contract.title) {
          fullContract = {
            ...defaultContract,
            ...contract,
            format_version: 2,
            workspace: contract.workspace ?? defaultContract.workspace,
            risk: contract.risk ?? defaultContract.risk,
            guardrails: {
              ...defaultContract.guardrails,
              ...contract.guardrails,
            },
            verifiers: (contract.verifiers ?? contract.evals ?? defaultContract.verifiers).map((v: any, idx: number) => ({
              id: v.id || `E${idx + 1}`,
              ...v,
              kind: v.kind === 'test' ? 'script' : (v.kind ?? 'script'),
            })),
            evals: (contract.evals ?? defaultContract.evals).map((v: any, idx: number) => ({
              id: v.id || `E${idx + 1}`,
              ...v,
              kind: v.kind === 'test' ? 'script' : (v.kind ?? 'script'),
            })),
            scenarios: (contract.scenarios ?? defaultContract.scenarios).map((s: any) => ({
              ...s,
              verifiers: s.verifiers ?? s.evals ?? ['E1'],
            })),
          }
        }
        writeFileSync(path.join(storiesDir, `${storyId}.json`), JSON.stringify(fullContract, null, 2), 'utf8')
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
      max_subscription_weekly_percent: 50,
    })
    expect(result.gates).toEqual([])
    expect(result.stories).toHaveLength(1)

    const story = result.stories[0]
    expect(story.id).toBe('ADE-T1')
    expect(story.spec_revision).toBe(digest16({ ...defaultContract, needs_ui: false }))
    expect(story.evals).toHaveLength(1)
    expect(story.evals[0]).toEqual({
      id: 'E1',
      format_version: 1,
      kind: 'script',
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
      max_subscription_weekly_percent: 50,
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
          format_version: 2,
          id: 'ADE-T1',
          title: 'Test Story with lone surrogate \uD800',
          complexity: 'bounded',
          task: 'Test task',
          workspace: {
            kind: 'git',
            root: '.',
          },
          risk: {
            level: 'normal',
            surfaces: [],
            evidence: [],
          },
          guardrails: {
            scope_paths: ['src/**'],
            do_not_touch: ['.ade/**'],
            autonomy: 'safe',
          },
          requirements: [{ id: 'R1', ears: 'WHEN x THE SYSTEM SHALL y.' }],
          scenarios: [{ id: 'C1', given: 'g', when: 'w', then: 't', verifiers: ['E1'] }],
          verifiers: [
            {
              id: 'E1',
              kind: 'script',
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
    }
  })

  // CA1: Dado um plano sem os limites opcionais da missão, quando ele é carregado, então os valores resultantes são 28.800 segundos, 3 unidades estacionadas e 50% semanais por assinatura
  test('ca1_mission_budget_defaults_when_optional_limits_omitted', () => {
    const { planPath } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 1,
        },
      },
    })
    const result = loadPlan(planPath)
    expect(result.missionBudget).toEqual({
      max_usd: 1,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
      max_subscription_weekly_percent: 50,
    })
  })

  // CA2: Dadas stories sem valores explícitos, quando são carregadas, então bounded sem interface recebe 6 chamadas/2 correções e bounded com interface recebe 8 chamadas/3 correções; feature recebe respectivamente 10/3 e 12/3
  test('ca2_story_contracts_receive_correct_budget_and_needs_ui_defaults', () => {
    const { defaultContract } = writePlanDir({ skipContracts: true })
    const { dir } = writePlanDir({
      plan: {
        phases: [
          {
            epics: [
              {
                stories: ['STORY-BOUNDED', 'STORY-BOUNDED-UI', 'STORY-FEATURE', 'STORY-FEATURE-UI'],
              },
            ],
          },
        ],
      },
      contracts: {
        'STORY-BOUNDED': {
          ...defaultContract,
          id: 'STORY-BOUNDED',
          complexity: 'bounded',
          budget: {},
        },
        'STORY-BOUNDED-UI': {
          ...defaultContract,
          id: 'STORY-BOUNDED-UI',
          complexity: 'bounded',
          needs_ui: true,
          budget: {},
        },
        'STORY-FEATURE': {
          ...defaultContract,
          id: 'STORY-FEATURE',
          complexity: 'feature',
          budget: {},
        },
        'STORY-FEATURE-UI': {
          ...defaultContract,
          id: 'STORY-FEATURE-UI',
          complexity: 'feature',
          needs_ui: true,
          budget: {},
        },
      },
    })
    const planPath = path.join(dir, 'plan.json')
    const result = loadPlan(planPath)

    const bounded = result.stories.find((s) => s.id === 'STORY-BOUNDED')!
    expect(bounded.contract.needs_ui).toBe(false)
    expect(bounded.contract.budget.max_model_calls).toBe(6)
    expect(bounded.contract.budget.max_rework_rounds).toBe(2)

    const boundedUi = result.stories.find((s) => s.id === 'STORY-BOUNDED-UI')!
    expect(boundedUi.contract.needs_ui).toBe(true)
    expect(boundedUi.contract.budget.max_model_calls).toBe(8)
    expect(boundedUi.contract.budget.max_rework_rounds).toBe(3)

    const feature = result.stories.find((s) => s.id === 'STORY-FEATURE')!
    expect(feature.contract.needs_ui).toBe(false)
    expect(feature.contract.budget.max_model_calls).toBe(10)
    expect(feature.contract.budget.max_rework_rounds).toBe(3)

    const featureUi = result.stories.find((s) => s.id === 'STORY-FEATURE-UI')!
    expect(featureUi.contract.needs_ui).toBe(true)
    expect(featureUi.contract.budget.max_model_calls).toBe(12)
    expect(featureUi.contract.budget.max_rework_rounds).toBe(3)
  })

  // CA3: Dado um plano com teto semanal 25 e uma story trivial com 2 chamadas/0 correções, quando ele é carregado, então 25, 2 e 0 são preservados
  test('ca3_explicit_subscription_weekly_percent_and_budget_values_are_preserved', () => {
    const { defaultContract } = writePlanDir({ skipContracts: true })
    const { dir } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 1,
          max_subscription_weekly_percent: 25,
        },
        phases: [
          {
            epics: [
              {
                stories: ['STORY-TRIVIAL'],
              },
            ],
          },
        ],
      },
      contracts: {
        'STORY-TRIVIAL': {
          ...defaultContract,
          id: 'STORY-TRIVIAL',
          complexity: 'trivial',
          budget: {
            max_model_calls: 2,
            max_rework_rounds: 0,
          },
        },
      },
    })
    const planPath = path.join(dir, 'plan.json')
    const result = loadPlan(planPath)

    expect(result.missionBudget.max_subscription_weekly_percent).toBe(25)
    const trivial = result.stories.find((s) => s.id === 'STORY-TRIVIAL')!
    expect(trivial.contract.budget.max_model_calls).toBe(2)
    expect(trivial.contract.budget.max_rework_rounds).toBe(0)
  })

  // CA4: Dado teto semanal maior que 50, negativo ou não numérico, quando o plano é carregado, então a entrada é recusada com saída 4 antes de qualquer execução
  test('ca4_subscription_weekly_percent_exceeding_50_negative_or_non_numeric_is_refused', () => {
    // maior que 50 (51) falha antes de preparar uma story (mesmo sem contratos)
    const { planPath: planAbove50 } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 1,
          max_subscription_weekly_percent: 51,
        },
      },
      skipContracts: true,
    })
    try {
      loadPlan(planAbove50)
      expect.unreachable('deveria ter falhado com exitCode 4 para teto > 50')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_schema_invalid')
      expect(err.exitCode).toBe(4)
    }

    // negativo (-1)
    const { planPath: planNegative } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 1,
          max_subscription_weekly_percent: -1,
        },
      },
    })
    try {
      loadPlan(planNegative)
      expect.unreachable('deveria ter falhado com exitCode 4 para teto negativo')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_schema_invalid')
      expect(err.exitCode).toBe(4)
    }

    // não numérico ("50")
    const { planPath: planNonNumeric } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 1,
          max_subscription_weekly_percent: '50',
        },
      },
    })
    try {
      loadPlan(planNonNumeric)
      expect.unreachable('deveria ter falhado com exitCode 4 para teto não numérico')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_schema_invalid')
      expect(err.exitCode).toBe(4)
    }
  })

  // Validação da tabela aprovada de defaultStoryBudget
  test('default_story_budget_table_matches_approved_spec', () => {
    expect(defaultStoryBudget({ complexity: 'trivial' })).toEqual({ max_model_calls: 3, max_rework_rounds: 1 })
    expect(defaultStoryBudget({ complexity: 'trivial', needs_ui: true })).toEqual({ max_model_calls: 3, max_rework_rounds: 1 })
    expect(defaultStoryBudget({ complexity: 'bounded' })).toEqual({ max_model_calls: 6, max_rework_rounds: 2 })
    expect(defaultStoryBudget({ complexity: 'bounded', needs_ui: false })).toEqual({ max_model_calls: 6, max_rework_rounds: 2 })
    expect(defaultStoryBudget({ complexity: 'bounded', needs_ui: true })).toEqual({ max_model_calls: 8, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'feature' })).toEqual({ max_model_calls: 10, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'feature', needs_ui: false })).toEqual({ max_model_calls: 10, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'feature', needs_ui: true })).toEqual({ max_model_calls: 12, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'subsystem' })).toEqual({ max_model_calls: 12, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'subsystem', needs_ui: true })).toEqual({ max_model_calls: 12, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'project' })).toEqual({ max_model_calls: 12, max_rework_rounds: 3 })
    expect(defaultStoryBudget({ complexity: 'project', needs_ui: true })).toEqual({ max_model_calls: 12, max_rework_rounds: 3 })
    expect(() => defaultStoryBudget({ complexity: 'unknown' as any })).toThrow(AdeError)
  })

  // CA5: max_usd acima de 300 é recusado com erro/4 (budget_usd_above_absolute_cap)
  test('ca5_plan_with_max_usd_above_300_is_refused', () => {
    const { planPath } = writePlanDir({
      plan: {
        mission_budget: {
          max_usd: 301,
        },
      },
    })
    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter falhado com exitCode 4 para max_usd > 300')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('budget_usd_above_absolute_cap')
      expect(err.exitCode).toBe(4)
    }

    try {
      loadPlan({ mission_budget: { max_usd: 301 } })
      expect.unreachable('deveria ter falhado com exitCode 4 para max_usd > 300')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('budget_usd_above_absolute_cap')
      expect(err.exitCode).toBe(4)
    }
  })
})
