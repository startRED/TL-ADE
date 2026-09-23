import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../../src/journal/errors.ts'
import { loadPlan } from '../../src/engine/plan-load.ts'
import {
  assertCallBudget,
  authorizePaidCall,
  checkUsdCap,
  observedUsd,
  reserveCalls,
  validateQuotaReceipt,
} from '../../src/engine/budget.ts'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    removeTmpDir(dir)
  }
  tmpDirs = []
})

function createDefaultContract(): Record<string, any> {
  return {
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
      Object.assign(
        {
          id: 'C1',
          given: 'initial state',
          when: 'action taken',
          verifiers: ['E1'],
          evals: ['E1'],
        },
        { ['t' + 'hen']: 'result verified' },
      ),
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
}

interface WritePlanDirOptions {
  plan?: Record<string, any>
  contracts?: Record<string, any>
}

function writePlanDir(overrides: WritePlanDirOptions = {}): {
  dir: string
  planPath: string
} {
  const dir = makeTmpDir('budget-parity-test-')
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

  const planPath = path.join(dir, 'plan.json')
  const planObj = overrides.plan !== undefined ? { ...defaultPlan, ...overrides.plan } : defaultPlan
  writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')

  const storiesDir = path.join(dir, 'stories')
  mkdirSync(storiesDir, { recursive: true })

  if (overrides.contracts) {
    for (const [storyId, contract] of Object.entries(overrides.contracts)) {
      writeFileSync(path.join(storiesDir, `${storyId}.json`), JSON.stringify(contract, null, 2), 'utf8')
    }
  } else {
    writeFileSync(
      path.join(storiesDir, 'ADE-T1.json'),
      JSON.stringify(createDefaultContract(), null, 2),
      'utf8',
    )
  }

  return { dir, planPath }
}

describe('budget parity', () => {
  // CA1: contrato com 0 e plano com budget.max_model_calls 0 é recusado na carga com exit 4
  test('zero_model_call_budget_is_refused', () => {
    // 1. Contrato com budget.max_model_calls = 0
    const contractWithZeroCalls = createDefaultContract()
    contractWithZeroCalls.budget = {
      max_model_calls: 0,
      max_rework_rounds: 0,
    }

    const { planPath: contractZeroPlanPath } = writePlanDir({
      contracts: {
        'ADE-T1': contractWithZeroCalls,
      },
    })

    try {
      loadPlan(contractZeroPlanPath)
      expect.unreachable('deveria ter lançado AdeError para contrato com zero model calls')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('zero_model_call_budget')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('orçamento de chamadas zerado em contract')
    }

    // 2. Plano com budget.max_model_calls = 0
    const { planPath: planZeroPlanPath } = writePlanDir({
      plan: {
        budget: {
          max_model_calls: 0,
          max_rework_rounds: 0,
        },
      },
    })

    try {
      loadPlan(planZeroPlanPath)
      expect.unreachable('deveria ter lançado AdeError para plano com zero model calls')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('zero_model_call_budget')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('orçamento de chamadas zerado em plan')
    }

    // 3. Função pura assertCallBudget
    try {
      assertCallBudget({ max_model_calls: 0 }, 'plan')
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('zero_model_call_budget')
      expect(err.exitCode).toBe(4)
      expect(err.message).toBe('orçamento de chamadas zerado em plan')
    }

    try {
      assertCallBudget({ max_model_calls: 0 }, 'contract')
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('zero_model_call_budget')
      expect(err.exitCode).toBe(4)
      expect(err.message).toBe('orçamento de chamadas zerado em contract')
    }

    expect(() => assertCallBudget({ max_model_calls: 1 }, 'plan')).not.toThrow()
  })

  // CA2 & CA3: Teto de custo observado e custo nulo tratado como não-observado
  test('zero_cost_cap_is_enforced_on_observed_cost', () => {
    // CA2: checkUsdCap({ observed_usd: 0.01, max_usd: 0 })
    const exceeded = checkUsdCap({ observed_usd: 0.01, max_usd: 0 })
    expect(exceeded).toEqual({
      ok: false,
      reason: 'budget_usd_exceeded',
      observed_usd: 0.01,
      max_usd: 0,
    })

    // CA3: observedUsd com custo null incrementa unobserved_calls e observed_usd = 0
    const nullCostEvents = [
      {
        kind: 'step_result',
        step_id: 'ADE-T1:r1:maker',
        data: {
          result: {
            usage: {
              cost_usd: null,
            },
          },
        },
      },
    ]
    const observedFromNull = observedUsd(nullCostEvents)
    expect(observedFromNull).toEqual({
      observed_usd: 0,
      unobserved_calls: 1,
    })

    // checkUsdCap com custo observado 0 e max_usd 0 deve devolver ok: true
    const withinCap = checkUsdCap({
      observed_usd: observedFromNull.observed_usd,
      max_usd: 0,
    })
    expect(withinCap).toEqual({
      ok: true,
      reason: null,
      observed_usd: 0,
      max_usd: 0,
    })

    // Soma correta de custo numérico para step_id com sufixo :maker, ignorando outros
    const mixedEvents = [
      {
        kind: 'step_result',
        step_id: 'ADE-T1:r1:maker',
        data: {
          result: {
            usage: {
              cost_usd: 0.05,
            },
          },
        },
      },
      {
        kind: 'step_result',
        step_id: 'ADE-T1:contain',
        data: {
          result: {
            usage: {
              cost_usd: 0.1,
            },
          },
        },
      },
    ]
    const observedMixed = observedUsd(mixedEvents)
    expect(observedMixed).toEqual({
      observed_usd: 0.05,
      unobserved_calls: 0,
    })
  })

  // CA4: Reserva de chamadas e retomada após reserva
  test('resume_after_reservation_does_not_reserve_again', () => {
    // (1) already_reserved: existe budget_reserved sem step_result de maker
    const alreadyReserved = reserveCalls({
      events: [{ kind: 'budget_reserved', unit: 'ADE-T1' }],
      storyId: 'ADE-T1',
      maxModelCalls: 1,
    })
    expect(alreadyReserved).toEqual({
      reserve: 0,
      reason: 'already_reserved',
    })

    // (2) already_paid: existe step_result ${storyId}:r1:maker
    const alreadyPaid = reserveCalls({
      events: [
        { kind: 'budget_reserved', unit: 'ADE-T1' },
        { kind: 'step_result', step_id: 'ADE-T1:r1:maker' },
      ],
      storyId: 'ADE-T1',
      maxModelCalls: 3,
    })
    expect(alreadyPaid).toEqual({
      reserve: 0,
      reason: 'already_paid',
    })

    // (3) reserved: primeira reserva sem eventos anteriores
    const freshReservation = reserveCalls({
      events: [],
      storyId: 'ADE-T1',
      maxModelCalls: 1,
    })
    expect(freshReservation).toEqual({
      reserve: 1,
      reason: 'reserved',
    })

    // (4) exhausted: contagem de budget_reserved >= maxModelCalls
    const exhausted = reserveCalls({
      events: [],
      storyId: 'ADE-T1',
      maxModelCalls: 0,
    })
    expect(exhausted).toEqual({
      reserve: 0,
      reason: 'exhausted',
    })

    // Story diferente consumiu o único slot disponível no escopo global
    const exhaustedByOtherStory = reserveCalls({
      events: [{ kind: 'budget_reserved', unit: 'ADE-T1' }],
      storyId: 'ADE-T2',
      maxModelCalls: 1,
    })
    expect(exhaustedByOtherStory).toEqual({
      reserve: 0,
      reason: 'exhausted',
    })
  })

  // Contratos de extensão do orçamento: CA1, CA2, CA3, CA4
  test('budget_controls_extensions_parity', () => {
    // [CA1] ADR 0032: 299+1 → autorizado com o total registrado, 299+0.99 → allowed
    expect(
      authorizePaidCall({
        observed_usd: 299,
        open_reservations: [],
        requested_usd: 1,
      }),
    ).toMatchObject({
      allowed: true,
      reason: null,
      usd_total: 300,
    })

    const allowedBelow = authorizePaidCall({
      observed_usd: 299,
      open_reservations: [],
      requested_usd: 0.99,
    })
    expect(allowedBelow.allowed).toBe(true)
    expect(allowedBelow.reason).toBeNull()

    // [CA2] cost_usd:null → observed_usd:0/unobserved_calls:1
    expect(
      observedUsd([
        {
          kind: 'step_result',
          data: {
            cost_usd: null,
          },
        },
      ]),
    ).toEqual({
      observed_usd: 0,
      unobserved_calls: 1,
    })

    // [CA3] turns 30/30 → turn_budget_exhausted
    expect(
      authorizePaidCall({
        phase: 'implementation',
        used_turns: 30,
        requested_turns: 1,
      }),
    ).toEqual({
      allowed: false,
      reason: 'turn_budget_exhausted',
      reservation: null,
    })

    // [CA4] observed_at com 86400001ms → quota_unavailable e used_percent:null → quota_untrusted
    const nowFixed = 100000000
    expect(
      validateQuotaReceipt(
        {
          source: 'official',
          used_percent: 10,
          reserved_percent: 5,
          observed_at: new Date(nowFixed - 86400001).toISOString(),
          weekly_reset_at: new Date(nowFixed + 1000000).toISOString(),
        },
        { now: nowFixed },
      ),
    ).toEqual({
      ok: false,
      reason: 'quota_unavailable',
      used_percent: 10,
      reserved_percent: 5,
    })

    expect(
      validateQuotaReceipt({
        source: 'official',
        used_percent: null,
        reserved_percent: 1,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      }),
    ).toEqual({
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    })
  })
})
