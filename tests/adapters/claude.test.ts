import fs from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { dispatchClaude } from '../../src/adapters/claude/index.ts'
import * as parseModule from '../../src/adapters/claude/parse.ts'
import { authorizedStep } from '../../src/engine/paid-call.ts'
import { digest16 } from '../../src/journal/canonical.ts'

const parseTokens = (parseModule as any).parseTokens

function paidAuthorization() {
  const now = Date.now()
  return {
    authorized: true as const,
    family: 'claude' as const,
    phase: 'implementation',
    context_bytes: 1,
    weekly_percent_cap: 50,
    reservation: { calls: 1, usd: 0.25, turns: 1, family: 'claude' as const },
    quota_receipt: {
      source: 'official', family: 'claude', used_percent: 0, reserved_percent: 0,
      observed_at: new Date(now).toISOString(), weekly_reset_at: new Date(now + 86400000).toISOString(),
    },
  }
}

describe('claude token parsing and telemetry adapter', () => {
  // CA1: Dado um stdout da CLI com usage {input_tokens 100, cache_creation_input_tokens 20, cache_read_input_tokens 500, output_tokens 40}
  // e total_cost_usd 0.0123, quando dispatchClaude roda com worker falso, então tokens é
  // {input: 100, cache_write: 20, cache_read: 500, output: 40, usd: 0.0123, source: 'reported'}
  test('reported_usage_is_journaled_verbatim', async () => {
    const envelope = {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 500,
        output_tokens: 40,
      },
      total_cost_usd: 0.0123,
    }

    expect(parseTokens(envelope)).toEqual({
      input: 100,
      cache_write: 20,
      cache_read: 500,
      output: 40,
      usd: 0.0123,
      source: 'reported',
    })

    // Exemplo: usd null quando total_cost_usd ausente
    const noCostEnvelope = {
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    }
    expect(parseTokens(noCostEnvelope)).toEqual({
      input: 1,
      cache_write: 0,
      cache_read: 0,
      output: 1,
      usd: null,
      source: 'reported',
    })

    // dispatchClaude com worker falso
    const fakeStep = async (spec: any, fn: any) => ({
      step_id: spec.id,
      status: 'ok',
      result: await fn(),
    })
    const fakeRunWorkerImpl = async () => ({
      stdout: JSON.stringify(envelope),
      exitCode: 0,
      stderr: '',
    })

    const res: any = await dispatchClaude({
      step: fakeStep,
      unit: 'S19',
      stepId: 'S19:r1:maker',
      packPath: '/fake/pack.md',
      missionDir: '/fake/m1',
      missionId: 'm1',
      cwd: '/fake/m1',
      resultFile: '/fake/m1/result.json',
      maxBudgetUsd: 0.25,
      resolved: { exe: 'node', prefixArgs: [] },
      runWorkerImpl: fakeRunWorkerImpl as any,
    })

    expect(res.tokens).toEqual({
      input: 100,
      cache_write: 20,
      cache_read: 500,
      output: 40,
      usd: 0.0123,
      source: 'reported',
    })
  })

  // CA2: Dado um envelope sem usage (só total_cost_usd: 0.01), quando parseTokens lê,
  // então o resultado é exatamente {source: 'unavailable'}, sem nenhuma chave numérica
  test('missing_usage_is_marked_unavailable_not_estimated', () => {
    const res = parseTokens({ total_cost_usd: 0.01 })
    expect(res).toEqual({ source: 'unavailable' })
    expect(Object.keys(res)).toEqual(['source'])

    expect(parseTokens({})).toEqual({ source: 'unavailable' })
    expect(parseTokens(null)).toEqual({ source: 'unavailable' })
  })

  // CA3: Dado um envelope com usage parcial (sem cache_read_input_tokens),
  // quando parseTokens lê, então o resultado é {source: 'unavailable'}
  test('partial_usage_is_marked_unavailable', () => {
    expect(
      parseTokens({
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 40,
        },
      }),
    ).toEqual({ source: 'unavailable' })

    // Contadores negativos ou não-inteiros
    expect(
      parseTokens({
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: -1,
          output_tokens: 40,
        },
        total_cost_usd: 0.01,
      }),
    ).toEqual({ source: 'unavailable' })

    expect(
      parseTokens({
        usage: {
          input_tokens: 1.5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 500,
          output_tokens: 40,
        },
        total_cost_usd: 0.01,
      }),
    ).toEqual({ source: 'unavailable' })
  })

  test('paid_call_binds_the_durable_authorization_before_the_spawn', async () => {
    const authorization = paidAuthorization()
    const specs: any[] = []
    const rawStep = async (spec: any, fn: any) => {
      specs.push(spec)
      return { step_id: spec.id, status: 'ok', result: await fn() }
    }
    const worker = vi.fn(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    await dispatchClaude({
      step: authorizedStep(rawStep, authorization), unit: 'S20', stepId: 'S20:r1:maker',
      packPath: '/fake/pack.md', missionDir: '/fake/m1', missionId: 'm1', cwd: '/fake/m1',
      resultFile: '/fake/m1/result.json', maxBudgetUsd: 0.25,
      resolved: { exe: 'node', prefixArgs: [] }, runWorkerImpl: worker as any,
    })
    expect(worker).toHaveBeenCalledTimes(1)
    expect(specs[0].effect_class).toBe('model_call')
    expect(specs[0].input.max_budget_usd).toBe(0.25)
    expect(specs[0].input.authorization).toBe(digest16(authorization))
  })

  test('paid_call_without_a_valid_reservation_never_reaches_the_worker', async () => {
    const worker = vi.fn()
    const rawStep = async (spec: any, fn: any) => ({ step_id: spec.id, status: 'ok', result: await fn() })
    for (const authorization of [
      { ...paidAuthorization(), reservation: { calls: 0 } },
      { ...paidAuthorization(), reservation: { calls: 1, usd: 300, turns: 1, family: 'claude' } },
    ]) {
      await expect(dispatchClaude({
        step: authorizedStep(rawStep, authorization as any), unit: 'S21', stepId: 'S21:r1:maker',
        packPath: '/fake/pack.md', missionDir: '/fake/m1', missionId: 'm1', cwd: '/fake/m1',
        resultFile: '/fake/m1/result.json', maxBudgetUsd: 0.25,
        resolved: { exe: 'node', prefixArgs: [] }, runWorkerImpl: worker as any,
      })).rejects.toMatchObject({ code: 'paid_call_unauthorized', exitCode: 4 })
    }
    expect(worker).not.toHaveBeenCalled()
  })

  test('paid_call_with_divergent_budget_is_rejected_by_adapter', async () => {
    const worker = vi.fn()
    const rawStep = async (spec: any, fn: any) => ({ step_id: spec.id, status: 'ok', result: await fn() })
    await expect(dispatchClaude({
      step: rawStep,
      unit: 'S22',
      stepId: 'S22:r1:maker',
      packPath: '/fake/pack.md',
      missionDir: '/fake/m1',
      missionId: 'm1',
      cwd: '/fake/m1',
      resultFile: '/fake/m1/result.json',
      maxBudgetUsd: 0.25,
      authorization: { ...paidAuthorization(), reservation: { calls: 1, usd: 300, turns: 1, family: 'claude' } } as any,
      resolved: { exe: 'node', prefixArgs: [] },
      runWorkerImpl: worker as any,
    })).rejects.toMatchObject({ code: 'paid_call_unauthorized', exitCode: 4 })
    expect(worker).not.toHaveBeenCalled()
  })

  test('checker_role_is_read_only_and_answers_by_the_review_schema', async () => {
    // o motor despacha todo revisor com role 'checker_round'; com planos, o Claude pode revisar a rodada de outra empresa
    const review = JSON.parse(fs.readFileSync(new URL('../../fixtures/schemas/review-result/valid.json', import.meta.url), 'utf8'))
    const argvs: string[][] = []
    const worker = vi.fn(async ({ args }: { args: string[] }) => {
      argvs.push(args)
      return { stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: review }), stderr: '', exitCode: 0 }
    })
    const rawStep = async (spec: any, fn: any) => ({ step_id: spec.id, status: 'ok', result: await fn() })
    const common = {
      step: rawStep, unit: 'S23', packPath: '/fake/pack.md', missionDir: '/fake/m1', missionId: 'm1', cwd: '/fake/m1',
      resultFile: '/fake/m1/result.json', maxBudgetUsd: 0.25, resolved: { exe: 'node', prefixArgs: [] }, runWorkerImpl: worker as any,
    }
    const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]

    expect(await dispatchClaude({ ...common, stepId: 'S23:r1:checker', role: 'checker_round' })).toMatchObject({ review_result: review, unit_result: null, valid: true })
    expect(flag(argvs[0], '--disallowedTools').split(',')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit']))
    expect(JSON.parse(flag(argvs[0], '--json-schema')).required).toContain('verdict')

    // quem escreve segue com escrita e o schema de resultado de unidade; papel desconhecido nem chega ao spawn
    expect(await dispatchClaude({ ...common, stepId: 'S23:r1:maker' })).toMatchObject({ review_result: null })
    expect(flag(argvs[1], '--disallowedTools')).toBe('Bash(git push*),Bash(git commit*),Bash(gh pr*)')
    expect(JSON.parse(flag(argvs[1], '--json-schema')).required).toContain('tree_after')
    await expect(dispatchClaude({ ...common, stepId: 'S23:r1:planner', role: 'planner' })).rejects.toMatchObject({ code: 'invalid_claude_args' })
    expect(worker).toHaveBeenCalledTimes(2)
  })
})
