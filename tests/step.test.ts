import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { digest16 } from '../src/journal/canonical.ts'
import { AdeError } from '../src/journal/errors.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { createStepRunner } from '../src/step/step.ts'
import { maybeFault } from '../src/step/fault.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    removeTmpDir(dir)
  }
  tmpDirs = []
})

function makeMissionDir(): string {
  const dir = makeTmpDir('ade-step-')
  tmpDirs.push(dir)
  return dir
}

function makeRunner(missionDir: string) {
  const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
  const { step } = createStepRunner({ journal, missionDir, gitPort: null, env: {} })
  return { journal, step }
}

function readEvents(missionDir: string): Array<Record<string, any>> {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

describe('step write-ahead durability', () => {
  // AC1: step novo grava step_intent e depois step_result para o mesmo step_id, nessa ordem de seq,
  // e a função de efeito é chamada uma vez.
  test('step_writes_intent_before_effect_and_result_after', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    let calls = 0
    const effectFn = async () => {
      calls += 1
      return { ok: true }
    }

    const result = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v1' } },
      effectFn,
    )

    expect(result).toEqual({
      step_id: 'T042:r1:maker',
      status: 'ok',
      result: { ok: true },
      reused: false,
    })
    expect(calls).toBe(1)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('step_intent')
    expect(events[0].seq).toBe(1)
    expect(events[0].step_id).toBe('T042:r1:maker')
    expect(events[1].kind).toBe('step_result')
    expect(events[1].seq).toBe(2)
    expect(events[1].step_id).toBe('T042:r1:maker')
    expect(events[1].status).toBe('ok')
    expect(events[1].data.result).toEqual({ ok: true })
  })

  // AC2: step_result com status 'ok' já gravado para o mesmo id e mesmo input faz a função de efeito
  // não ser chamada de novo e o resultado voltar marcado como reaproveitado.
  test('step_reuses_recorded_result_without_running_the_effect', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    let calls = 0
    const effectFn = async () => {
      calls += 1
      return { count: calls }
    }

    const spec = { unit: 'T042', id: 'T042:once', effect_class: 'local_write' as const, input: { a: 1 } }

    const first = await step(spec, effectFn)
    expect(first).toEqual({ step_id: 'T042:once', status: 'ok', result: { count: 1 }, reused: false })
    expect(calls).toBe(1)

    const second = await step(spec, effectFn)
    expect(second).toEqual({ step_id: 'T042:once', status: 'ok', result: { count: 1 }, reused: true })
    expect(calls).toBe(1)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
  })

  // AC3: model_call já fechado (status ok ou ambiguous) volta com o veredicto gravado sem reexecutar
  // quando o input muda; local_write com input diferente reexecuta.
  test('model_call_is_reused_by_step_id_even_with_a_different_input_digest', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    const first = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v1' } },
      async () => ({ ok: true }),
    )
    expect(first).toEqual({ step_id: 'T042:r1:maker', status: 'ok', result: { ok: true }, reused: false })

    const throwsIfCalled = async () => {
      throw new Error('effectFn não deveria ser chamada de novo')
    }

    const second = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v2' } },
      throwsIfCalled,
    )
    expect(second).toEqual({ step_id: 'T042:r1:maker', status: 'ok', result: { ok: true }, reused: true })

    // Contraste: local_write com input diferente reexecuta o efeito.
    let writeCalls = 0
    const writeEffect = async () => {
      writeCalls += 1
      return { done: true }
    }

    const writeFirst = await step(
      { unit: 'T042', id: 'T042:write', effect_class: 'local_write', input: { a: 1 } },
      writeEffect,
    )
    expect(writeFirst.reused).toBe(false)
    expect(writeCalls).toBe(1)

    const writeSecond = await step(
      { unit: 'T042', id: 'T042:write', effect_class: 'local_write', input: { a: 2 } },
      writeEffect,
    )
    expect(writeSecond.reused).toBe(false)
    expect(writeCalls).toBe(2)
  })

  // AC3 (ramo ambiguous): model_call reconciliada como ambiguous é definitiva; step() nunca a redispara
  // e devolve o veredicto com a evidência gravada.
  test('model_call_reconciled_as_ambiguous_is_not_redispatched', async () => {
    const missionDir = makeMissionDir()
    const { journal, step } = makeRunner(missionDir)

    await journal.append({
      kind: 'step_result',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'seed' }),
      status: 'ambiguous',
      reason: 'call_consumed',
      evidence: { checkpoint_ref: 'refs/ade/checkpoints/x/1' },
    })

    const throwsIfCalled = async () => {
      throw new Error('effectFn não deveria ser chamada para model_call ambiguous')
    }

    const result = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v9' } },
      throwsIfCalled,
    )

    expect(result).toEqual({
      step_id: 'T042:r1:maker',
      status: 'ambiguous',
      result: null,
      reused: true,
      reason: 'call_consumed',
      evidence: { checkpoint_ref: 'refs/ade/checkpoints/x/1' },
    })

    const events = readEvents(missionDir)
    expect(events).toHaveLength(1)
  })

  // Reuso de model_call 'ok' propaga reason e evidence gravados em data, não só no ramo ambiguous.
  test('model_call_reused_as_ok_propagates_reason_and_evidence_from_prior_data', async () => {
    const missionDir = makeMissionDir()
    const { journal, step } = makeRunner(missionDir)

    await journal.append({
      kind: 'step_result',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'seed' }),
      status: 'ok',
      result: { ok: true },
      reason: 'tree_unchanged',
      evidence: { checkpoint_ref: 'refs/ade/checkpoints/x/1' },
    })

    const throwsIfCalled = async () => {
      throw new Error('effectFn não deveria ser chamada de novo')
    }

    const result = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v9' } },
      throwsIfCalled,
    )

    expect(result).toEqual({
      step_id: 'T042:r1:maker',
      status: 'ok',
      result: { ok: true },
      reused: true,
      reason: 'tree_unchanged',
      evidence: { checkpoint_ref: 'refs/ade/checkpoints/x/1' },
    })

    const events = readEvents(missionDir)
    expect(events).toHaveLength(1)
  })

  // Argumentos inválidos de intent_context/worktree/receiptPath lançam TypeError curto
  // antes de gravar qualquer evento.
  test('invalid_intent_context_and_worktree_arguments_are_rejected_before_writing', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    await expect(
      step(
        { unit: 'T042', id: 'T042:bad-null', effect_class: 'none', input: {}, intent_context: null as any },
        async () => ({}),
      ),
    ).rejects.toThrow(TypeError)

    await expect(
      step(
        {
          unit: 'T042',
          id: 'T042:bad-value',
          effect_class: 'none',
          input: {},
          intent_context: { head_before: 123 as any },
        },
        async () => ({}),
      ),
    ).rejects.toThrow(TypeError)

    await expect(
      step(
        { unit: 'T042', id: 'T042:bad-worktree', effect_class: 'none', input: {}, worktree: 5 as any },
        async () => ({}),
      ),
    ).rejects.toThrow(TypeError)

    await expect(
      step(
        { unit: 'T042', id: 'T042:bad-receipt', effect_class: 'none', input: {}, receiptPath: 5 as any },
        async () => ({}),
      ),
    ).rejects.toThrow(TypeError)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(0)
  })

  // AC: intent_context nunca entra no input_digest e só aceita as oito chaves fechadas;
  // chave fora da lista lança TypeError antes de gravar qualquer evento.
  test('intent_context_stays_out_of_the_input_digest', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    await step(
      { unit: 'T042', id: 'T042:ctx-a', effect_class: 'none', input: { same: true }, intent_context: { head_before: 'aaa' } },
      async () => ({ v: 1 }),
    )

    const eventsAfterFirst = readEvents(missionDir)
    const intentDigest = eventsAfterFirst[0].input_digest

    let secondCalls = 0
    await step(
      { unit: 'T042', id: 'T042:ctx-b', effect_class: 'none', input: { same: true }, intent_context: { head_before: 'bbb', branch_before: 'main' } },
      async () => {
        secondCalls += 1
        return { v: 2 }
      },
    )

    const eventsAfterSecond = readEvents(missionDir)
    const secondIntentDigest = eventsAfterSecond[2].input_digest
    expect(secondIntentDigest).toBe(intentDigest)

    await expect(
      step(
        { unit: 'T042', id: 'T042:bad-ctx', effect_class: 'none', input: {}, intent_context: { foo: 'bar' } },
        async () => ({}),
      ),
    ).rejects.toThrow(TypeError)

    const eventsAfterInvalid = readEvents(missionDir)
    expect(eventsAfterInvalid).toHaveLength(4)
  })

  // AC4: efeito que lança faz o journal registrar step_result com status 'failed' e o erro original
  // é relançado para quem chamou step().
  test('failed_effect_records_a_failed_step_result_and_rethrows', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    const boom = new Error('boom')
    const effectFn = async () => {
      throw boom
    }

    await expect(
      step({ unit: 'T042', id: 'T042:fail', effect_class: 'local_write', input: { a: 1 } }, effectFn),
    ).rejects.toBe(boom)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('step_intent')
    expect(events[1].kind).toBe('step_result')
    expect(events[1].status).toBe('failed')
  })
})

describe('step queue by unit', () => {
  // AC1: dois step() disparados sem await na mesma unidade não se sobrepõem no tempo
  // e a ordem de entrada é preservada.
  test('two_concurrent_steps_on_the_same_unit_are_serialized', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)
    const order: string[] = []

    const effectA = async () => {
      order.push('a:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('a:end')
      return { who: 'a' }
    }
    const effectB = async () => {
      order.push('b:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('b:end')
      return { who: 'b' }
    }

    const pA = step({ unit: 'T042', id: 'T042:queue-a', effect_class: 'local_write', input: { a: 1 } }, effectA)
    const pB = step({ unit: 'T042', id: 'T042:queue-b', effect_class: 'local_write', input: { a: 2 } }, effectB)

    await Promise.all([pA, pB])

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  // AC2: dois step() disparados sem await em unidades diferentes podem se sobrepor
  // (o segundo começa antes de o primeiro terminar).
  test('steps_on_different_units_are_not_serialized', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)
    const order: string[] = []

    const effectA = async () => {
      order.push('a:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('a:end')
      return { who: 'a' }
    }
    const effectB = async () => {
      order.push('b:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('b:end')
      return { who: 'b' }
    }

    const pA = step({ unit: 'T042', id: 'T042:queue-a2', effect_class: 'local_write', input: { a: 1 } }, effectA)
    const pB = step({ unit: 'T043', id: 'T043:queue-b2', effect_class: 'local_write', input: { a: 2 } }, effectB)

    await Promise.all([pA, pB])

    expect(order).toEqual(['a:start', 'b:start', 'a:end', 'b:end'])
  })

  // step() é async: unit inválida rejeita a Promise em vez de lançar de forma síncrona.
  test('step_rejects_asynchronously_for_invalid_unit', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    let result: Promise<unknown> | undefined
    expect(() => {
      result = step({ unit: 123 as any, id: 'T042:x', effect_class: 'none', input: {} }, async () => ({}))
    }).not.toThrow()

    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toThrow(TypeError)
  })
})

describe('fault points', () => {
  test('maybeFault_rejects_unknown_fault_points', () => {
    expect(() => maybeFault('depois', {})).toThrow(TypeError)
  })
})

describe('step session_ref', () => {
  // CA3: session_ref que não é string não vazia nem null lança AdeError('invalid_session_ref', ...)
  // antes de qualquer append, e o journal continua vazio.
  test('step_rejects_a_non_string_non_null_session_ref_before_writing_and_the_journal_stays_empty', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    try {
      await step(
        { unit: 'u1', id: 'x1', effect_class: 'none', input: {}, session_ref: 42 as any },
        async () => ({}),
      )
      expect.unreachable('deveria ter lançado AdeError para session_ref inválido')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_session_ref')
      expect(adeErr.message).toBe('session_ref inválido')
      expect(adeErr.exitCode).toBe(2)
    }

    const events = readEvents(missionDir)
    expect(events).toEqual([])
  })

  // Borda: string vazia segue a mesma regra ('string não vazia ou null'), então também é rejeitada
  // sem gravar nada no journal.
  test('step_rejects_an_empty_string_session_ref_before_writing', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    try {
      await step({ unit: 'u1', id: 'x2', effect_class: 'none', input: {}, session_ref: '' }, async () => ({}))
      expect.unreachable('deveria ter lançado AdeError para session_ref vazio')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      expect((err as AdeError).code).toBe('invalid_session_ref')
    }

    const events = readEvents(missionDir)
    expect(events).toEqual([])
  })

  // CA3: step() sem session_ref grava session_ref null no step_intent.
  test('step_intent_records_session_ref_null_when_not_provided', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    await step({ unit: 'u1', id: 'x3', effect_class: 'none', input: {} }, async () => ({}))

    const events = readEvents(missionDir)
    const intent = events.find((ev) => ev.kind === 'step_intent')
    expect(intent).toBeTruthy()
    expect(intent!.session_ref).toBeNull()
  })

  // AC3: session_ref string válida é gravada tal como recebida no step_intent.
  test('step_intent_records_the_provided_session_ref_string', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    await step(
      {
        unit: 'u1',
        id: 'x4',
        effect_class: 'model_call',
        input: {},
        session_ref: '11111111-2222-4333-8444-555555555555',
      },
      async () => ({ ok: true }),
    )

    const events = readEvents(missionDir)
    const intent = events.find((ev) => ev.kind === 'step_intent')
    expect(intent!.session_ref).toBe('11111111-2222-4333-8444-555555555555')
  })
})
