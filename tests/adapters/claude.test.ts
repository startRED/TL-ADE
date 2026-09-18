import { describe, expect, test } from 'vitest'
import { dispatchClaude } from '../../src/adapters/claude/index.js'
import * as parseModule from '../../src/adapters/claude/parse.js'

const parseTokens = (parseModule as any).parseTokens

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
})
