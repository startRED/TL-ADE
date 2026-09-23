import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../src/git/gitport.ts'
import { callCost, formatMeasureTrailers, storyMeasure } from '../src/telemetry/cost.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

// Uso fabricado como o adaptador dublê do Claude o devolveria (parseTokens).
const REPORTED = { source: 'reported', input: 100, output: 40, cache_read: 500, cache_write: 20, usd: 0.0123 }

function telemetryInput(overrides: Record<string, any> = {}) {
  return {
    mission_id: 'mission-1',
    story_id: 'ADE-T1',
    step_id: 'ADE-T1:r1:maker',
    family: 'claude',
    role: 'maker',
    effort: 'default',
    models: [{ role: 'executor', model_id: 'claude-opus-5' }],
    duration_ms: 90_000,
    tokens: REPORTED,
    usage: undefined,
    pack: { sections: [{ section: 'contract', bytes: 10, digest: '1111111111111111' }], bytes: 10 },
    skills: [],
    sources: [],
    outcome: 'ok',
    ttft_ms: null,
    approval_decisions: 0,
    network_attempts: 0,
    files_touched: 0,
    tool_output_raw_bytes: 0,
    tool_output_model_bytes: 0,
    ...overrides,
  }
}

function call(seq: number, storyId: string, tokens: Record<string, unknown>, durationMs: number) {
  return {
    seq,
    kind: 'telemetry',
    unit: storyId,
    data: buildModelTelemetry(telemetryInput({ story_id: storyId, step_id: `${storyId}:r${seq}:maker`, tokens, duration_ms: durationMs })),
  }
}

let repoDirs: string[] = []
afterEach(() => {
  for (const d of repoDirs) removeRepo(d)
  repoDirs = []
})

describe('custo, tokens e minutos por chamada e parte', () => {
  test('criterio_1_chamada_com_uso_reportado_registra_preco_tokens_e_minutos', () => {
    expect(callCost({ model: 'claude-opus-5', usage: REPORTED, durationMs: 90_000 })).toEqual({
      usd_equiv: 0.0123,
      tokens_in: 100,
      tokens_out: 40,
      tokens_cache: 520,
      minutes: 1.5,
    })

    const event = buildModelTelemetry(telemetryInput())
    expect(event.cost_usd).toBe(0.0123)
    expect(event.tokens_in).toBe(100)
    expect(event.tokens_out).toBe(40)
    expect(event.tokens_cache).toBe(520)
    expect(event.minutes).toBe(1.5)
  })

  test('criterio_2_resumo_da_parte_soma_exatamente_as_tres_chamadas', () => {
    const events = [
      { seq: 1, kind: 'story_started', unit: 'ADE-T1', data: { unit: 'ADE-T1', criteria: 2 } },
      call(2, 'ADE-T1', { ...REPORTED, input: 100, output: 10, cache_read: 1, cache_write: 2, usd: 0.25 }, 60_000),
      call(3, 'ADE-T1', { ...REPORTED, input: 200, output: 20, cache_read: 3, cache_write: 4, usd: 0.5 }, 120_000),
      call(4, 'ADE-T1', { ...REPORTED, input: 300, output: 30, cache_read: 5, cache_write: 6, usd: 0.125 }, 30_000),
      // Chamada de outra parte não entra na soma.
      call(5, 'ADE-T2', { ...REPORTED, usd: 9 }, 600_000),
      { seq: 6, kind: 'contain_result', unit: 'ADE-T1', data: { changedPaths: ['src/a.ts'] } },
      { seq: 7, kind: 'review_result', unit: 'ADE-T1', data: { round: 1, approved: true } },
    ]

    expect(storyMeasure(events, 'ADE-T1')).toEqual({
      criteria: 2,
      files: 1,
      rounds: 1,
      calls: 3,
      unknown_cost_calls: 0,
      usd: 0.875,
      tokens_in: 600,
      tokens_out: 60,
      tokens_cache: 21,
      minutes: 3.5,
    })
  })

  test('criterio_3_commit_da_parte_traz_trailers_de_criterios_arquivos_rodadas_e_usd', async () => {
    const events = [
      { seq: 1, kind: 'story_started', unit: 'ADE-T1', data: { unit: 'ADE-T1', criteria: 5 } },
      call(2, 'ADE-T1', { ...REPORTED, usd: 0.5 }, 60_000),
      call(3, 'ADE-T1', { ...REPORTED, usd: 0.9 }, 60_000),
      call(4, 'ADE-T1', { ...REPORTED, usd: 0.02 }, 60_000),
      { seq: 5, kind: 'contain_result', unit: 'ADE-T1', data: { changedPaths: ['a.txt'] } },
      { seq: 6, kind: 'review_result', unit: 'ADE-T1', data: { round: 1, approved: false } },
      { seq: 7, kind: 'contain_result', unit: 'ADE-T1', data: { changedPaths: ['a.txt', 'b.txt', 'c.txt'] } },
      { seq: 8, kind: 'review_result', unit: 'ADE-T1', data: { round: 2, approved: true } },
    ]
    const trailers = formatMeasureTrailers(storyMeasure(events, 'ADE-T1'))
    expect(trailers).toBe('ADE-Criterios: 5\nADE-Arquivos: 3\nADE-Rodadas: 2\nADE-USD: 1.42')

    const repo = makeRepo()
    repoDirs.push(repo.dir)
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(repo.dir, f), 'ok\n', 'utf8')
    await createGitPort({ worktreeDir: repo.dir }).commit({ message: `ade(ADE-T1): Parte\n\n${trailers}` })

    const parsed = repo.git(['log', '-1', '--format=%(trailers:only,unfold)']).trim().split('\n')
    expect(parsed).toEqual(['ADE-Criterios: 5', 'ADE-Arquivos: 3', 'ADE-Rodadas: 2', 'ADE-USD: 1.42'])
  })

  test('criterio_4_chamada_sem_uso_reportado_fica_desconhecida_nunca_zero', () => {
    for (const usage of [undefined, { source: 'unavailable' }]) {
      expect(callCost({ model: 'gpt-5.5', usage, durationMs: 30_000 })).toEqual({
        usd_equiv: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache: null,
        minutes: 0.5,
      })
    }

    const event = buildModelTelemetry(telemetryInput({ tokens: { source: 'unavailable' } }))
    expect(event.tokens_source).toBe('unknown')
    expect(event.cost_source).toBe('unknown')
    for (const key of ['cost_usd', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'tokens_cache']) {
      expect(event[key]).toBeNull()
    }

    // Parte só com chamadas sem custo: o USD é desconhecido, não 0.
    const measure = storyMeasure([call(1, 'ADE-T1', { source: 'unavailable' }, 60_000)], 'ADE-T1')
    expect(measure.usd).toBeNull()
    expect(measure.unknown_cost_calls).toBe(1)
    expect(measure.criteria).toBeNull()
    expect(formatMeasureTrailers(measure)).toBe(
      'ADE-Criterios: desconhecido\nADE-Arquivos: desconhecido\nADE-Rodadas: 0\nADE-USD: desconhecido\nADE-USD-Sem-Custo: 1',
    )
  })

  test('borda_uso_ou_duracao_invalidos_sao_recusados', () => {
    expect(() => callCost({ model: 'claude-opus-5', usage: REPORTED, durationMs: -1 })).toThrow(/telemetria inválida/)
    expect(() => callCost({ model: 'claude-opus-5', usage: { ...REPORTED, input: -5 }, durationMs: 1000 })).toThrow(/telemetria inválida/)
    expect(() => callCost({ model: '', usage: REPORTED, durationMs: 1000 })).toThrow(/telemetria inválida/)
  })
})
