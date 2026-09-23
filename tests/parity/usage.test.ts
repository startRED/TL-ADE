import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parseUsage } from '../../src/adapters/claude/parse.ts'

const TRANSCRIPTS_DIR = fileURLToPath(new URL('../../fixtures/transcripts/claude/', import.meta.url))

function readTranscriptEnvelope(name: string): Record<string, unknown> {
  const raw = readFileSync(path.join(TRANSCRIPTS_DIR, name, 'stdout.json'), 'utf8')
  return JSON.parse(raw)
}

describe('usage parity', () => {
  // AC2: sem total_cost_usd, objeto vazio, ou total_cost_usd como string -> parseUsage nunca inventa
  // custo (regra I45); cost_usd e cost_basis ficam nulos e cost_source é sempre 'unknown', mesmo
  // quando modelUsage.*.costUSD existe, e models nunca fica vazio quando há modelUsage.
  test('usage_parsers_never_invent', () => {
    expect(parseUsage({})).toEqual({ cost_usd: null, cost_source: 'unknown', cost_basis: null, models: [] })

    const stringCost = parseUsage({ total_cost_usd: '0.1' })
    expect(stringCost.cost_source).toBe('unknown')
    expect(stringCost.cost_usd).toBeNull()

    // borda: modelUsage.*.costUSD existe, mas total_cost_usd não é number finito -> ainda 'unknown';
    // nunca soma nem copia o custo por modelo (regra I45).
    const withModelCostButStringTotal = {
      total_cost_usd: '0.1',
      modelUsage: {
        'claude-haiku-4-5-20251001': { costUSD: 0.5, costBasis: 'list' },
      },
    }
    const modelCostResult = parseUsage(withModelCostButStringTotal)
    expect(modelCostResult.cost_usd).toBeNull()
    expect(modelCostResult.cost_source).toBe('unknown')
    expect(modelCostResult.models).toEqual([{ role: 'maker', model_id: 'claude-haiku-4-5-20251001' }])

    // fixture real sem total_cost_usd nem costBasis em modelUsage: custo e base ficam nulos, mas
    // models ainda é derivado das chaves de modelUsage.
    const withoutCostEnvelope = readTranscriptEnvelope('ok_without_cost')
    const withoutCostResult = parseUsage(withoutCostEnvelope)
    expect(withoutCostResult).toEqual({
      cost_usd: null,
      cost_source: 'unknown',
      cost_basis: null,
      models: [{ role: 'maker', model_id: 'claude-haiku-4-5-20251001' }],
    })

    // role customizado é refletido em todos os itens de models, sem afetar a regra de custo.
    expect(parseUsage(withModelCostButStringTotal, 'checker').models).toEqual([
      { role: 'checker', model_id: 'claude-haiku-4-5-20251001' },
    ])
  })
})
