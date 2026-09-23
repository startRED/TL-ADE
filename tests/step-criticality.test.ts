import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { createStepRunner } from '../src/step/step.ts'
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
  const dir = makeTmpDir('ade-step-crit-')
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

describe('step criticality', () => {
  // CA1: Dado um passo bem-sucedido sem criticidade declarada, quando ele termina, então intenção e resultado registram required e o retorno permanece ok.
  // [CA1] passo sem criticidade que retorna {ok:true} → ok com criticidade required
  test('CA1_step_without_criticality_defaults_to_required_and_returns_ok', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    const result = await step(
      { unit: 'T042', id: 'T042:ca1', effect_class: 'none', input: { query: 'test' } },
      async () => ({ ok: true }),
    )

    expect(result).toEqual({
      step_id: 'T042:ca1',
      status: 'ok',
      result: { ok: true },
      reused: false,
    })

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('step_intent')
    expect(events[0].data?.criticality).toBe('required')
    expect(events[1].kind).toBe('step_result')
    expect(events[1].status).toBe('ok')
    expect(events[1].data?.criticality).toBe('required')
  })

  // CA2: Dado um passo required cujo efeito lança boom, quando ele executa, então o journal registra falha obrigatória e o mesmo erro boom é devolvido ao chamador.
  // [CA2] passo required que lança boom → journal failed e rejeição com boom
  test('CA2_required_step_failure_records_failed_and_rethrows', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    const boom = new Error('boom')
    const effectFn = async () => {
      throw boom
    }

    await expect(
      step(
        { unit: 'T042', id: 'T042:ca2', effect_class: 'local_write', input: { a: 1 }, criticality: 'required' },
        effectFn,
      ),
    ).rejects.toBe(boom)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('step_intent')
    expect(events[0].data?.criticality).toBe('required')
    expect(events[1].kind).toBe('step_result')
    expect(events[1].status).toBe('failed')
    expect(events[1].data?.criticality).toBe('required')
  })

  // CA3: Dado um passo enhancement cujo efeito lança preview unavailable, quando ele executa, então retorna degraded com resultado nulo, registra o erro e a execução seguinte da unidade pode continuar.
  // [CA3] passo enhancement que lança → retorno degraded, sem rejeição
  test('CA3_enhancement_step_failure_records_degraded_and_returns_without_throwing', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    const previewError = new Error('preview unavailable')
    const result = await step(
      { unit: 'T042', id: 'T042:ca3', effect_class: 'none', input: { preview: true }, criticality: 'enhancement' },
      async () => {
        throw previewError
      },
    )

    expect(result).toEqual({
      step_id: 'T042:ca3',
      status: 'degraded',
      result: null,
      reused: false,
    })

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('step_intent')
    expect(events[0].data?.criticality).toBe('enhancement')
    expect(events[1].kind).toBe('step_result')
    expect(events[1].status).toBe('degraded')
    expect(events[1].data?.criticality).toBe('enhancement')
    expect(events[1].data?.error?.message).toBe('preview unavailable')

    // Execução seguinte da mesma unidade pode continuar
    const nextResult = await step(
      { unit: 'T042', id: 'T042:ca3-next', effect_class: 'none', input: { next: true } },
      async () => ({ continued: true }),
    )
    expect(nextResult.status).toBe('ok')
    expect(nextResult.result).toEqual({ continued: true })
  })

  // CA4: Dado um resultado enhancement degradado já gravado, quando o mesmo passo é retomado, então retorna o resultado degradado com reused:true sem executar novamente o efeito.
  // [CA4] retomada do passo degradado → reused:true e zero novo efeito
  test('CA4_resuming_degraded_enhancement_step_reuses_result_without_rerunning_effect', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    let calls = 0
    const effectFn = async () => {
      calls += 1
      throw new Error('preview unavailable')
    }

    const spec = {
      unit: 'T042',
      id: 'T042:ca4',
      effect_class: 'none' as const,
      input: { preview: true },
      criticality: 'enhancement' as const,
    }

    const first = await step(spec, effectFn)
    expect(first).toEqual({
      step_id: 'T042:ca4',
      status: 'degraded',
      result: null,
      reused: false,
    })
    expect(calls).toBe(1)

    // Segunda chamada do mesmo id (retomada)
    const second = await step(spec, effectFn)
    expect(second).toEqual({
      step_id: 'T042:ca4',
      status: 'degraded',
      result: null,
      reused: true,
    })
    expect(calls).toBe(1)

    const events = readEvents(missionDir)
    expect(events).toHaveLength(2)
    expect(events[1].data?.error?.message).toBe('preview unavailable')
  })

  // CA5: Dada criticidade optional ou valor não textual, quando o passo é solicitado, então ocorre TypeError('criticality inválida') antes de qualquer evento no journal.
  // [CA5] criticidade optional → TypeError('criticality inválida') e nenhum evento
  test('CA5_invalid_criticality_is_rejected_with_type_error_before_journal_write', async () => {
    const missionDir = makeMissionDir()
    const { step } = makeRunner(missionDir)

    await expect(
      step(
        { unit: 'T042', id: 'T042:ca5-opt', effect_class: 'none', input: {}, criticality: 'optional' as any },
        async () => ({}),
      ),
    ).rejects.toThrow(new TypeError('criticality inválida'))

    await expect(
      step(
        { unit: 'T042', id: 'T042:ca5-num', effect_class: 'none', input: {}, criticality: 123 as any },
        async () => ({}),
      ),
    ).rejects.toThrow(new TypeError('criticality inválida'))

    await expect(
      step(
        { unit: 'T042', id: 'T042:ca5-bool', effect_class: 'none', input: {}, criticality: true as any },
        async () => ({}),
      ),
    ).rejects.toThrow(new TypeError('criticality inválida'))

    await expect(
      step(
        { unit: 'T042', id: 'T042:ca5-obj', effect_class: 'none', input: {}, criticality: {} as any },
        async () => ({}),
      ),
    ).rejects.toThrow(new TypeError('criticality inválida'))

    const events = readEvents(missionDir)
    expect(events).toHaveLength(0)
  })
})
