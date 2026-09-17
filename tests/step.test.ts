import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { digest16 } from '../src/journal/canonical.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { createStepRunner } from '../src/step/step.js'
import { maybeFault } from '../src/step/fault.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

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

describe('fault points', () => {
  test('maybeFault_rejects_unknown_fault_points', () => {
    expect(() => maybeFault('depois', {})).toThrow(TypeError)
  })
})
