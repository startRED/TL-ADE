import { describe, expect, test } from 'vitest'
import { AdeError } from '../../src/journal/errors.js'
import { nextReady, validateGraph } from '../../src/engine/schedule.js'
import { checkMissionBudget } from '../../src/engine/budget.js'
import { detectLoop, normalize } from '../../src/engine/loop.js'
import { loadPlan } from '../../src/engine/plan-load.js'
import { validateEvidenceResult } from '../../src/review/validate.js'

describe('policy parity', () => {
  // Parity sources: test_batch_runs_two_dependent_units_and_closes, test_continue_independent_after_block_runs_unrelated_unit
  test('ca1_graph_order_cycle_and_missing_dependencies', () => {
    // Exemplo 1: [{id:'b',depends_on:['a']},{id:'a',depends_on:[]}] com states {} -> {id:'a'}
    const ready1 = nextReady(
      [
        { id: 'b', depends_on: ['a'] },
        { id: 'a', depends_on: [] },
      ],
      {},
    )
    expect(ready1).toEqual({ id: 'a' })

    // Se 'a' estiver concluída em states, a próxima pronta é 'b'
    const ready2 = nextReady(
      [
        { id: 'b', depends_on: ['a'] },
        { id: 'a', depends_on: [] },
      ],
      { a: 'completed' },
    )
    expect(ready2).toEqual({ id: 'b' })

    // Empate usa ordenação alfabética por id
    const readyTie = nextReady(
      [
        { id: 'c', depends_on: [] },
        { id: 'a', depends_on: [] },
        { id: 'b', depends_on: [] },
      ],
      {},
    )
    expect(readyTie).toEqual({ id: 'a' })

    // Exemplo 2: ciclo [{id:'a',depends_on:['b']},{id:'b',depends_on:['a']}] -> AdeError {exitCode:2}
    expect(() => {
      try {
        validateGraph([
          { id: 'a', depends_on: ['b'] },
          { id: 'b', depends_on: ['a'] },
        ])
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(2)
        throw err
      }
    }).toThrow()

    // Ciclo via nextReady também recusa com exitCode 2 e porta em calls:0
    expect(() => {
      try {
        nextReady(
          [
            { id: 'a', depends_on: ['b'] },
            { id: 'b', depends_on: ['a'] },
          ],
          {},
        )
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(2)
        throw err
      }
    }).toThrow()

    // Dependência ausente é recusada com exitCode 2
    expect(() => {
      try {
        validateGraph([{ id: 'a', depends_on: ['inexistente'] }])
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(2)
        throw err
      }
    }).toThrow()

    // ID duplicado é recusado com exitCode 2
    expect(() => {
      try {
        validateGraph([
          { id: 'a', depends_on: [] },
          { id: 'a', depends_on: [] },
        ])
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(2)
        throw err
      }
    }).toThrow()

  })

  // Parity sources: test_zero_model_call_budget_is_refused, test_budget_reserve_stops_before_an_unverifiable_unit
  test('ca2_budget_call_wall_clock_and_parked_units_limits', () => {
    // Exemplo 1: {events:[],budget:{max_model_calls:0},now:1} -> {allowed:false,reason:'model_call_budget_exhausted'}
    const r1 = checkMissionBudget({
      events: [],
      budget: { max_model_calls: 0 },
      now: 1,
    })
    expect(r1).toEqual({ allowed: false, reason: 'model_call_budget_exhausted' })

    // Exemplo 2: {events:[{at:0}],budget:{max_wall_clock_ms:10},now:11} -> {allowed:false,reason:'wall_clock_exhausted'}
    const r2 = checkMissionBudget({
      events: [{ at: 0 }],
      budget: { max_wall_clock_ms: 10 },
      now: 11,
    })
    expect(r2).toEqual({ allowed: false, reason: 'wall_clock_exhausted' })

    // Limite de unidades estacionadas (awaiting_operator):
    const r3 = checkMissionBudget({
      events: [],
      budget: { max_parked_units: 1 },
      now: 1,
      states: { s1: 'awaiting_operator' },
    })
    expect(r3).toEqual({ allowed: false, reason: 'max_parked_units' })

    // Orçamento suficiente permite execução:
    const rOk = checkMissionBudget({
      events: [{ at: 5 }],
      budget: { max_model_calls: 5, max_wall_clock_ms: 100, max_parked_units: 3 },
      now: 10,
      states: {},
    })
    expect(rOk).toEqual({ allowed: true, reason: null })

    // Sequência de reserva e resultado da mesma story conta como uma única chamada (sem dupla contagem):
    const rSeq = checkMissionBudget({
      events: [
        { kind: 'budget_reserved', unit: 'story-1' },
        { kind: 'step_result', step_id: 'story-1:r1:maker' },
      ],
      budget: { max_model_calls: 2 },
      now: 10,
    })
    expect(rSeq).toEqual({ allowed: true, reason: null })

  })

  // Parity sources: test_same_findings_twice_is_stagnation, test_loop_detector_parks_on_repeated_gate_signature, test_diff_oscillation_parks
  test('ca3_loop_detection_stagnation_and_oscillation', () => {
    // Exemplo 1: ['erro 12:00','erro 13:00'] -> {kind:'stagnation',signature:'erro <t>'}
    const resStag = detectLoop(['erro 12:00', 'erro 13:00'])
    expect(resStag).toEqual({ kind: 'stagnation', signature: 'erro <t>' })

    // Exemplo 2: ['a','b','a'] -> {kind:'oscillation',signature:'a'}
    const resOsc = detectLoop(['a', 'b', 'a'])
    expect(resOsc).toEqual({ kind: 'oscillation', signature: 'a' })

    // Sem repetição: kind 'none'
    const resNone = detectLoop(['a', 'b'])
    expect(resNone).toEqual({ kind: 'none', signature: null })

    // Normalização completa: minúsculo, timestamp, tempo, hex, path, num, espaços
    const raw = '2026-09-19T20:21:01.123Z ERRO 150ms no C:/Project/src/index.js commit 0123456789abcdef linha 42'
    const norm = normalize(raw)
    expect(norm).toBe('erro <t> no <path> commit <hex> linha <n>')

  })

  // Parity sources: test_non_boolean_optional_effects_are_refused, test_local_write_false_is_refused_before_any_dispatch, test_unauthorized_push_is_never_attempted
  test('ca4_unauthorized_and_non_boolean_effects_refusal', () => {
    // Exemplo: {push:'false'} -> AdeError {exitCode:4,calls:0}
    expect(() => {
      try {
        loadPlan({ push: 'false' })
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(4)
        throw err
      }
    }).toThrow()

    // Efeito externo não autorizado:
    expect(() => {
      try {
        loadPlan({ deploy: true })
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.exitCode).toBe(4)
        throw err
      }
    }).toThrow()

  })

  // Parity sources: test_stale_runtime_version_stops_until_accepted, test_spec_drift_and_scope_drift_are_refused
  test('ca5_evidence_result_and_stale_revision_validation', () => {
    // Exemplo: {input_revision:'old'} contra context {input_revision:'new'} -> erro stale_result
    const resStale = validateEvidenceResult(
      'review-result',
      { input_revision: 'old' },
      { input_revision: 'new' },
    )
    expect(resStale.valid).toBe(false)
    if (!resStale.valid) {
      expect(resStale.code).toBe(4)
      const err = resStale.errors.find((e) => e.code === 'stale_result')
      expect(err).toBeDefined()
    }

    // Notes UTF-8 acima de 500 bytes é recusado
    const resNotes = validateEvidenceResult(
      'review-result',
      {
        format_version: 2,
        handoff: { notes: '😀'.repeat(126) }, // 126 * 4 = 504 bytes
      },
      {},
    )
    expect(resNotes.valid).toBe(false)
    if (!resNotes.valid) {
      expect(resNotes.code).toBe(4)
      expect(resNotes.errors.some((e) => e.code === 'notes_too_large')).toBe(true)
    }

  })
})
