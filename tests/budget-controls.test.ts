import { describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'
import { loadPlan } from '../src/engine/plan-load.ts'
import {
  ABSOLUTE_USD_CAP,
  PHASE_TURN_LIMITS,
  authorizePaidCall,
  observedUsd,
  validateQuotaReceipt,
} from '../src/engine/budget.ts'

describe('budget controls', () => {
  // CA1: Teto absoluto de US$ 300 e reservas abertas
  test('ca1_absolute_usd_cap_and_open_reservations', () => {
    expect(ABSOLUTE_USD_CAP).toBe(300)

    // ADR 0032: o dólar é informativo; 299+1 é autorizado e o total fica registrado
    const atCap = authorizePaidCall({
      observed_usd: 299,
      open_reservations: [],
      requested_usd: 1,
    })
    expect(atCap).toMatchObject({
      allowed: true,
      reason: null,
      usd_total: 300,
    })

    // [CA1] 299+0.99 → allowed
    const belowCap = authorizePaidCall({
      observed_usd: 299,
      open_reservations: [],
      requested_usd: 0.99,
    })
    expect(belowCap.allowed).toBe(true)
    expect(belowCap.reason).toBeNull()
    expect(belowCap.reservation).toMatchObject({ usd: 0.99 })

    // Reserva aberta somada ao observed_usd
    // Evento budget_reserved para unit 'story-1' com usd: 10, sem step_result :maker nem story_done
    const eventsWithOpenRes = [
      {
        kind: 'budget_reserved',
        unit: 'story-1',
        data: { usd: 10 },
      },
    ]
    const resBlockedByOpenRes = authorizePaidCall({
      events: eventsWithOpenRes,
      observed_usd: 289,
      requested_usd: 1,
    })
    expect(resBlockedByOpenRes).toMatchObject({
      allowed: true,
      reason: null,
      usd_total: 300,
    })

    // Se story-1 já tiver step_result de maker, a reserva não é mais aberta
    const eventsClosedByMaker = [
      {
        kind: 'budget_reserved',
        unit: 'story-1',
        data: { usd: 10 },
      },
      {
        kind: 'step_result',
        step_id: 'story-1:r1:maker',
        data: { cost_usd: 5 },
      },
    ]
    const resAllowedAfterMaker = authorizePaidCall({
      events: eventsClosedByMaker,
      observed_usd: 289,
      requested_usd: 1,
    })
    expect(resAllowedAfterMaker.allowed).toBe(true)

    // Se story-1 tiver story_done, a reserva não é mais aberta
    const eventsClosedByStoryDone = [
      {
        kind: 'budget_reserved',
        unit: 'story-1',
        data: { usd: 10 },
      },
      {
        kind: 'story_done',
        unit: 'story-1',
      },
    ]
    const resAllowedAfterStoryDone = authorizePaidCall({
      events: eventsClosedByStoryDone,
      observed_usd: 289,
      requested_usd: 1,
    })
    expect(resAllowedAfterStoryDone.allowed).toBe(true)
  })

  // CA2: Custo desconhecido/null contabilizado como unobserved_calls
  test('ca2_unknown_cost_treated_as_unobserved_calls', () => {
    // EXEMPLO CA2: {events:[{kind:'step_result',data:{cost_usd:null}}]} → {observed_usd:0,unobserved_calls:1}
    const resultNullCost = observedUsd([
      {
        kind: 'step_result',
        data: { cost_usd: null },
      },
    ])
    expect(resultNullCost).toEqual({
      observed_usd: 0,
      unobserved_calls: 1,
    })

    // cost_usd ausente
    const resultMissingCost = observedUsd([
      {
        kind: 'step_result',
      },
    ])
    expect(resultMissingCost).toEqual({
      observed_usd: 0,
      unobserved_calls: 1,
    })

    // cost_usd numérico é somado sem incrementar unobserved_calls
    const resultValidCost = observedUsd([
      {
        kind: 'step_result',
        data: { cost_usd: 2.5 },
      },
    ])
    expect(resultValidCost).toEqual({
      observed_usd: 2.5,
      unobserved_calls: 0,
    })
  })

  // CA3: Cinco limites (chamadas, parede, unidades estacionadas, turnos, contexto)
  test('ca3_five_limits_refuse_calls_with_specific_reasons', () => {
    expect(PHASE_TURN_LIMITS).toEqual({
      proof: 14,
      implementation: 30,
      correction: 20,
      review: 10,
    })

    // 1. Limite de turnos
    // EXEMPLO CA3: {phase:'implementation',used_turns:30,requested_turns:1} → {allowed:false,reason:'turn_budget_exhausted'}
    const turnExhausted = authorizePaidCall({
      phase: 'implementation',
      used_turns: 30,
      requested_turns: 1,
    })
    expect(turnExhausted).toEqual({
      allowed: false,
      reason: 'turn_budget_exhausted',
      reservation: null,
    })

    const turnProofExhausted = authorizePaidCall({
      phase: 'proof',
      used_turns: 14,
      requested_turns: 1,
    })
    expect(turnProofExhausted).toEqual({
      allowed: false,
      reason: 'turn_budget_exhausted',
      reservation: null,
    })

    // 2. Limite de chamadas de modelo (mission_budget.max_model_calls)
    const callBudgetExhausted = authorizePaidCall({
      events: [
        { kind: 'budget_reserved', unit: 'u1' },
        { kind: 'budget_reserved', unit: 'u2' },
      ],
      mission_budget: { max_model_calls: 2 },
    })
    expect(callBudgetExhausted).toEqual({
      allowed: false,
      reason: 'model_call_budget_exhausted',
      reservation: null,
    })

    // 3. Limite de tempo de parede (mission_budget.max_wall_clock_seconds)
    const wallClockExhausted = authorizePaidCall({
      events: [{ kind: 'session_start', at: 1000 }],
      mission_budget: { max_wall_clock_seconds: 10 },
      now: 12000,
    })
    expect(wallClockExhausted).toEqual({
      allowed: false,
      reason: 'wall_clock_exhausted',
      reservation: null,
    })

    // 4. Limite de unidades estacionadas (mission_budget.max_parked_units)
    const parkedExhausted = authorizePaidCall({
      mission_budget: { max_parked_units: 2 },
      states: {
        s1: 'awaiting_operator',
        s2: 'awaiting_operator',
      },
    })
    expect(parkedExhausted).toEqual({
      allowed: false,
      reason: 'max_parked_units',
      reservation: null,
    })

    // 5. Limite de contexto (context_bytes >= context_limit)
    const contextExceeded = authorizePaidCall({
      context_bytes: 120000,
      context_limit: 120000,
    })
    expect(contextExceeded).toEqual({
      allowed: false,
      reason: 'context_limit_exceeded',
      reservation: null,
    })

    const contextDefaultExceeded = authorizePaidCall({
      context_bytes: 120000,
    })
    expect(contextDefaultExceeded).toEqual({
      allowed: false,
      reason: 'context_limit_exceeded',
      reservation: null,
    })

    const contextAllowed = authorizePaidCall({
      context_bytes: 119999,
      context_limit: 120000,
    })
    expect(contextAllowed.allowed).toBe(true)
  })

  // CA4: Validação de recibo de cota por família
  test('ca4_quota_receipt_validation_and_rejection', () => {
    // Recibo ausente
    const missingReceipt = validateQuotaReceipt(null)
    expect(missingReceipt).toEqual({
      ok: false,
      reason: 'quota_unavailable',
      used_percent: null,
      reserved_percent: null,
    })

    // Fonte não oficial
    const unofficialReceipt = validateQuotaReceipt({
      source: 'manual',
      used_percent: 10,
      reserved_percent: 5,
      observed_at: '2026-09-20T00:00:00.000Z',
      weekly_reset_at: '2026-09-27T00:00:00.000Z',
    })
    expect(unofficialReceipt).toEqual({
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    })

    // EXEMPLO CA4: {source:'official',used_percent:null,reserved_percent:1,observed_at:'2026-09-20T00:00:00.000Z',weekly_reset_at:'2026-09-27T00:00:00.000Z'} → {ok:false,reason:'quota_untrusted'}
    const untrustedReceipt = validateQuotaReceipt({
      source: 'official',
      used_percent: null,
      reserved_percent: 1,
      observed_at: '2026-09-20T00:00:00.000Z',
      weekly_reset_at: '2026-09-27T00:00:00.000Z',
    })
    expect(untrustedReceipt).toEqual({
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    })

    // Recibo vencido (observed_at com 86400001ms de idade)
    const fixedNow = new Date('2026-09-21T00:00:00.001Z').getTime()
    const expiredReceipt = validateQuotaReceipt(
      {
        source: 'official',
        used_percent: 10,
        reserved_percent: 5,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      },
      { now: fixedNow },
    )
    expect(expiredReceipt).toEqual({
      ok: false,
      reason: 'quota_unavailable',
      used_percent: 10,
      reserved_percent: 5,
    })

    // Recibo com weekly_reset_at ultrapassado
    const pastResetReceipt = validateQuotaReceipt(
      {
        source: 'official',
        used_percent: 10,
        reserved_percent: 5,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-20T12:00:00.000Z',
      },
      { now: new Date('2026-09-20T13:00:00.000Z').getTime() },
    )
    expect(pastResetReceipt).toEqual({
      ok: false,
      reason: 'quota_unavailable',
      used_percent: 10,
      reserved_percent: 5,
    })

    // Recibo com soma used_percent + reserved_percent >= 50
    const exhaustedReceipt = validateQuotaReceipt(
      {
        source: 'official',
        used_percent: 45,
        reserved_percent: 5,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      },
      { now: new Date('2026-09-20T01:00:00.000Z').getTime() },
    )
    expect(exhaustedReceipt).toEqual({
      ok: false,
      reason: 'quota_exhausted',
      used_percent: 45,
      reserved_percent: 5,
    })

    // Recibo válido
    const validReceipt = validateQuotaReceipt(
      {
        source: 'official',
        family: 'claude',
        used_percent: 20,
        reserved_percent: 10,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      },
      { family: 'claude', now: new Date('2026-09-20T01:00:00.000Z').getTime() },
    )
    expect(validReceipt).toEqual({
      ok: true,
      reason: null,
      used_percent: 20,
      reserved_percent: 10,
    })

    // authorizePaidCall recusa antes da reserva se recibo de cota for ausente ou inválido para a família
    const callRefusedByMissingQuota = authorizePaidCall({
      family: 'claude',
      quota_receipt: null,
    })
    expect(callRefusedByMissingQuota).toEqual({
      allowed: false,
      reason: 'quota_unavailable',
      reservation: null,
    })
  })

  // CA5: Rejeição de max_usd > 300, negativo ou valores não finitos com AdeError exitCode 4
  test('ca5_plan_and_reservation_invalid_inputs_rejected', () => {
    // EXEMPLO CA5: {mission_budget:{max_usd:301}} → AdeError('budget_usd_above_absolute_cap',4)
    expect(() => {
      loadPlan({ mission_budget: { max_usd: 301 } })
    }).toThrow(AdeError)

    try {
      loadPlan({ mission_budget: { max_usd: 301 } })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('budget_usd_above_absolute_cap')
      expect(err.exitCode).toBe(4)
    }

    // max_usd negativo
    try {
      loadPlan({ mission_budget: { max_usd: -1 } })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('budget_usd_above_absolute_cap')
      expect(err.exitCode).toBe(4)
    }

    // authorizePaidCall rejeita requested_usd negativo com AdeError exitCode 4
    expect(() => {
      authorizePaidCall({ requested_usd: -5 })
    }).toThrow(AdeError)

    try {
      authorizePaidCall({ requested_usd: -5 })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.exitCode).toBe(4)
    }

    // authorizePaidCall rejeita requested_calls negativo
    expect(() => {
      authorizePaidCall({ requested_calls: -1 })
    }).toThrow(AdeError)

    // authorizePaidCall rejeita requested_turns negativo
    expect(() => {
      authorizePaidCall({ requested_turns: -1 })
    }).toThrow(AdeError)

    // authorizePaidCall com mission_budget.max_usd > 300
    try {
      authorizePaidCall({ mission_budget: { max_usd: 301 } })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('budget_usd_above_absolute_cap')
      expect(err.exitCode).toBe(4)
    }
  })
})
