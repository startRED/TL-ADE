import { describe, expect, test } from 'vitest'
import { fold, openIntents } from '../src/journal/fold.js'

function ev(
  seq: number,
  kind: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format_version: 1,
    seq,
    at: '2026-09-17T12:00:00Z',
    prev: '0000000000000000',
    kind,
    effect_class: 'none',
    input_digest: '0123456789abcdef',
    intent_context: {},
    worktree: '',
    receipt_path: '',
    session_ref: null,
    runtime_stamp: '1:aa:bb',
    ...extra,
  }
}

describe('journal fold', () => {
  // AC1: Dado [], devolve o estado zero consolidado
  test('fold_of_empty_journal_is_the_zero_state', () => {
    const state = fold([])
    expect(state).toEqual({
      lastSeq: 0,
      kinds: {},
      steps: {},
      openIntents: [],
      decisions: [],
    })
    expect(openIntents([])).toEqual([])
  })

  // AC2: Rastreia steps e lista intenções abertas ordenadas por seq
  test('fold_tracks_steps_and_open_intents', () => {
    const events = [
      ev(1, 'step_intent', { step_id: 'A' }),
      ev(2, 'step_result', { step_id: 'A', status: 'ok' }),
      ev(3, 'step_intent', { step_id: 'B' }),
    ]

    const state = fold(events)
    expect(state.lastSeq).toBe(3)
    expect(state.kinds).toEqual({
      step_intent: 2,
      step_result: 1,
    })
    expect(state.steps.A).toEqual({
      step_id: 'A',
      effect_class: 'none',
      input_digest: '0123456789abcdef',
      runtime_stamp: '1:aa:bb',
      intent_seq: 1,
      result_seq: 2,
      status: 'ok',
    })
    expect(state.openIntents).toEqual([
      {
        seq: 3,
        step_id: 'B',
        effect_class: 'none',
        input_digest: '0123456789abcdef',
        runtime_stamp: '1:aa:bb',
      },
    ])
    expect(openIntents(events)).toEqual(state.openIntents)

    // Result órfão (sem intent prévio)
    const orphanState = fold([ev(1, 'step_result', { step_id: 'Z', status: 'ok' })])
    expect(orphanState.steps.Z).toEqual({
      step_id: 'Z',
      effect_class: 'none',
      input_digest: '0123456789abcdef',
      runtime_stamp: '1:aa:bb',
      intent_seq: null,
      result_seq: 1,
      status: 'ok',
    })
    expect(orphanState.openIntents).toEqual([])
  })

  // AC3: Novo step_intent com mesmo step_id reabre o step
  test('fold_reopens_a_step_on_new_intent', () => {
    const events = [
      ev(1, 'step_intent', { step_id: 'A' }),
      ev(2, 'step_result', { step_id: 'A', status: 'released' }),
      ev(3, 'step_intent', { step_id: 'A' }),
    ]

    const state = fold(events)
    expect(state.lastSeq).toBe(3)
    expect(state.steps.A).toEqual({
      step_id: 'A',
      effect_class: 'none',
      input_digest: '0123456789abcdef',
      runtime_stamp: '1:aa:bb',
      intent_seq: 3,
      result_seq: null,
      status: null,
    })
    expect(state.openIntents).toEqual([
      {
        seq: 3,
        step_id: 'A',
        effect_class: 'none',
        input_digest: '0123456789abcdef',
        runtime_stamp: '1:aa:bb',
      },
    ])
  })

  // AC4: É pura (imutável com arrays congelados) e rejeita tipos não-array com TypeError
  test('fold_is_pure_and_rejects_non_array', () => {
    const e1 = Object.freeze(ev(1, 'step_intent', { step_id: 'A' }))
    const e2 = Object.freeze(ev(2, 'step_result', { step_id: 'A', status: 'ok' }))
    const frozenEvents = Object.freeze([e1, e2])

    const res1 = fold(frozenEvents)
    const res2 = fold(frozenEvents)
    expect(res1).toEqual(res2)

    expect(() => fold('x' as unknown as Array<Record<string, unknown>>)).toThrow(TypeError)
    expect(() => fold('x' as unknown as Array<Record<string, unknown>>)).toThrow('fold: events deve ser um array')
    expect(() => fold(null as unknown as Array<Record<string, unknown>>)).toThrow(TypeError)
    expect(() => openIntents('x' as unknown as Array<Record<string, unknown>>)).toThrow(TypeError)
    expect(() => openIntents('x' as unknown as Array<Record<string, unknown>>)).toThrow('fold: events deve ser um array')
  })

  // AC5: Coleta decisions e ignora step_intent sem step_id nos steps
  test('fold_collects_decisions_and_ignores_steps_without_id', () => {
    const events = [
      ev(1, 'step_intent', { step_id: null }),
      ev(2, 'decision', { source: 'operator', data: { decision: 'accept_stale_version' } }),
      ev(3, 'decision', {}),
    ]

    const state = fold(events)
    expect(state.lastSeq).toBe(3)
    expect(state.kinds).toEqual({
      step_intent: 1,
      decision: 2,
    })
    expect(Object.keys(state.steps)).toEqual([])
    expect(state.openIntents).toEqual([])
    expect(state.decisions).toEqual([
      {
        seq: 2,
        source: 'operator',
        data: { decision: 'accept_stale_version' },
      },
      {
        seq: 3,
        source: null,
        data: {},
      },
    ])
  })
})
