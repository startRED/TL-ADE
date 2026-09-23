import { describe, expect, test } from 'vitest'
import { CATALOG, EFFORTS, PLANS, ROLES } from '../src/models/catalog.ts'
import type { RoleId } from '../src/models/catalog.ts'
import { buildChains, capacityPressure, measureQuality, scoreFor } from '../src/models/chains.ts'

// Segunda-feira 21/09/2026, 00:00 UTC; a semana renova no domingo seguinte.
const NOW = Date.parse('2026-09-21T00:00:00Z')
const WEEK_MS = 7 * 24 * 3600 * 1000
const intel = (model: string, effort: string) => CATALOG.find((e) => e.model === model && e.effort === effort)!.intelligence
const tag = (s: { model: string; effort: string; reserve?: true }) => `${s.model}(${s.effort})${s.reserve ? ' reserva' : ''}`

// Chamada de quem escreve no formato real do journal (telemetria de model_call) e o parecer do revisor que vem depois.
function writerCall(unit: string, model: string, extra: Record<string, unknown> = {}) {
  return { kind: 'telemetry', unit, data: { story_id: unit, role: 'maker', effort: 'default', models: [{ role: 'executor', model_id: model }], duration_ms: 0, files_touched: 3, ...extra } }
}
const review = (unit: string, approved: boolean) => ({ kind: 'review_result', unit, data: { round: 1, approved } })
function journal(model: string, reviewed: number, approved: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: reviewed }, (_, i) => [writerCall(`s${i}`, model, extra), review(`s${i}`, i < approved)]).flat()
}

describe('catálogo, capacidade, qualidade e filas de modelos', () => {
  test('CA1: catálogo tem família, modelo, rótulo, esforço, inteligência, custo e segundos; planos de cada empresa', () => {
    expect(CATALOG.length).toBeGreaterThan(20)
    for (const e of CATALOG) {
      expect(['claude', 'codex', 'agy']).toContain(e.family)
      expect(e.model).toMatch(/\S/)
      expect(e.label).toMatch(/\S/)
      expect(EFFORTS).toContain(e.effort)
      expect(e.intelligence).toBeGreaterThan(0)
      expect(e.costPerTask).toBeGreaterThan(0)
      expect(e.seconds).toBeGreaterThan(0)
    }
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(PLANS.claude.tiers.map((t) => t.label)).toEqual(['Não tenho', 'Pro', 'Max 5x', 'Max 20x', 'API'])
    expect(PLANS.codex.tiers.map((t) => t.label)).toEqual(['Não tenho', 'Plus', 'Pro 5x', 'Pro 20x', 'API'])
    expect(PLANS.agy.tiers.map((t) => t.label)).toEqual(['Não tenho', 'Gratuito', 'AI Pro', 'AI Ultra R$ 750', 'AI Ultra R$ 1.000'])
    expect(Object.keys(ROLES).sort()).toEqual(['checker', 'epics', 'fix', 'impl', 'impl_hard', 'impl_light', 'plan', 'plan_edit', 'test'])
  })

  test('CA2: 60% usados com metade da semana projeta 1,2; sem leitura pesa pelo plano; API não tem pressão', () => {
    const resets = new Date(NOW + WEEK_MS / 2).toISOString()
    expect(capacityPressure({ size: 20 }, { used: 60, resets_at: resets, source: 'official' }, NOW)).toBeCloseTo(1.2, 5)
    const max5 = capacityPressure(PLANS.claude.tiers.find((t) => t.id === 'max5'), null, NOW)
    const max20 = capacityPressure(PLANS.claude.tiers.find((t) => t.id === 'max20'), null, NOW)
    expect(max20).toBeLessThan(max5)
    expect(max20).toBeGreaterThan(0)
    expect(capacityPressure(PLANS.claude.tiers.find((t) => t.id === 'api'), { used: 99, resets_at: resets, source: 'official' }, NOW)).toBe(0)
  })

  test('CA3: 80% de aprovação em 5+ revisões sobe a qualidade de quem escreve; menos de 5 fica igual; sem mudar arquivo baixa; revisar não muda', () => {
    const entry = CATALOG.find((e) => e.model === 'gpt-6-sol' && e.effort === 'high')!
    const ctx = { tier: PLANS.codex.tiers.find((t) => t.id === 'pro20'), reading: null, now: NOW }
    const measured = measureQuality(journal('gpt-6-sol', 10, 8))
    expect(measured['gpt-6-sol']).toMatchObject({ calls: 10, reviewed: 10, approved: 8, unchanged: 0 })
    const high = scoreFor(entry, 'impl', { ...ctx, measured })
    expect(high.quality).toBeGreaterThan(entry.intelligence)
    expect(high.parts.join(' · ')).toContain('revisor aprovou 80% de 10')
    const { why } = buildChains({ plans: { codex: 'pro20' }, measured, now: NOW })
    expect(why.impl.join('\n')).toContain('revisor aprovou 80% de 10')

    const few = measureQuality(journal('gpt-6-sol', 4, 4))
    expect(scoreFor(entry, 'impl', { ...ctx, measured: few }).quality).toBe(entry.intelligence)

    const idle = measureQuality(journal('gpt-6-sol', 10, 8, { files_touched: 0 }))
    expect(idle['gpt-6-sol'].unchanged).toBe(10)
    expect(scoreFor(entry, 'impl', { ...ctx, measured: idle }).quality).toBeLessThan(high.quality)
    // o contain da parte com arquivos mudados vale mais que o files_touched zerado da telemetria
    const contained = measureQuality([{ kind: 'contain_result', unit: 'x', data: { changedPaths: ['a.ts'] } }, writerCall('x', 'gpt-6-sol', { files_touched: 0 })])
    expect(contained['gpt-6-sol'].unchanged).toBe(0)

    expect(scoreFor(entry, 'checker', { ...ctx, measured }).quality).toBe(entry.intelligence)
    expect(scoreFor(entry, 'checker', { ...ctx, measured }).parts.join(' ')).not.toContain('medido aqui')
  })

  test('CA4: Max 20x + Plus: só o que o Plus libera, até 3 modelos, um esforço por modelo fora da escada, mínimo antes e revisor de outra empresa', () => {
    const { chains } = buildChains({ plans: { claude: 'max20', codex: 'plus' }, now: NOW })
    const plus = PLANS.codex.tiers.find((t) => t.id === 'plus')!.models!
    for (const [role, chain] of Object.entries(chains) as Array<[RoleId, typeof chains.impl]>) {
      expect(chain.length).toBeGreaterThan(0)
      for (const s of chain.filter((x) => x.family === 'codex')) expect(plus).toContain(s.model)
      const models = chain.map((s) => s.model)
      expect(new Set(models).size).toBeLessThanOrEqual(3)
      if (role !== 'fix') {
        expect(new Set(models).size).toBe(models.length)
        const meets = chain.map((s) => intel(s.model, s.effort) >= ROLES[role].minIntelligence)
        expect(meets).toEqual([...meets].sort((a, b) => Number(b) - Number(a)))
      }
    }
    const writer = chains.impl[0].family
    expect(chains.checker.slice(0, 2).every((s) => s.family !== writer)).toBe(true)
  })

  test('CA4 exemplo: impl Opus 5.5 (high) → GPT-6 Astra (high) → um esforço por modelo', () => {
    // 10 chamadas medidas do Astra em high a 3 min cada: o tempo medido aqui vale mais que o do site
    const timed = Array.from({ length: 10 }, (_, i) => writerCall(`t${i}`, 'gpt-6-astra', { effort: 'high', duration_ms: 180_000 }))
    const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro20' }, measured: measureQuality(timed), now: NOW })
    expect(chains.impl.slice(0, 2).map(tag)).toEqual(['claude-opus-5-5(high)', 'gpt-6-astra(high)'])
    expect(new Set(chains.impl.map((s) => s.model)).size).toBe(chains.impl.length)
  })

  test('CA5: escada começa no titular do código difícil, sobe em inteligência repetindo o modelo e termina em reserva de outra empresa', () => {
    const timed = Array.from({ length: 10 }, (_, i) => writerCall(`t${i}`, 'gpt-6-astra', { effort: 'high', duration_ms: 180_000 }))
    const { chains, why } = buildChains({ plans: { claude: 'max20', codex: 'pro20' }, measured: measureQuality(timed), now: NOW })
    expect(chains.fix.map(tag)).toEqual([
      'claude-opus-5-5(high)', 'claude-opus-5-5(xhigh)', 'claude-opus-5-5(max)', 'gpt-6-astra(high) reserva',
    ])
    expect(chains.fix[0]).toMatchObject({ model: chains.impl_hard[0].model, effort: chains.impl_hard[0].effort })
    expect(why.fix[3]).toContain('reserva')
  })

  test('CA5: qualidade medida alta com inteligência menor entra como candidato sem passar um degrau mais inteligente', () => {
    const measured = measureQuality(journal('claude-fable-5-1', 10, 9))
    const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro20' }, measured, now: NOW })
    const steps = chains.fix.filter((s) => !s.reserve)
    const levels = steps.map((s) => intel(s.model, s.effort))
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
    // Fable high tem nota maior que Opus 5.5 high pela aprovação medida, mas fica abaixo dele na escada
    expect(chains.fix.map(tag)).toEqual([
      'claude-fable-5-1(medium)', 'claude-fable-5-1(high)', 'claude-opus-5-5(high)', 'gpt-6-astra(medium) reserva',
    ])
    expect(chains.fix.at(-1)!.family).not.toBe(chains.fix[0].family)
  })

  test('CA5: com uma só empresa a escada não tem reserva', () => {
    const { chains } = buildChains({ plans: { claude: 'max20' }, now: NOW })
    expect(chains.fix.length).toBeGreaterThan(1)
    expect(chains.fix.some((s) => s.reserve)).toBe(false)
    expect(new Set(chains.fix.map((s) => s.family))).toEqual(new Set(['claude']))
  })

  test('CA6: modelo bloqueado não aparece em papel nenhum, nem como reserva', () => {
    const plans = { claude: 'max20', codex: 'pro20' }
    expect(JSON.stringify(buildChains({ plans, now: NOW }).chains)).toContain('gpt-6-astra')
    const { chains } = buildChains({ plans, blocked: ['gpt-6-astra', 'claude-opus-5-5'], now: NOW })
    for (const chain of Object.values(chains)) {
      expect(chain.length).toBeGreaterThan(0)
      expect(chain.map((s) => s.model)).not.toContain('gpt-6-astra')
      expect(chain.map((s) => s.model)).not.toContain('claude-opus-5-5')
    }
    expect(chains.fix.at(-1)!.reserve).toBe(true)
  })

  test('CA7: esforço fixado em high no código comum usa o high dos modelos que o oferecem', () => {
    const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro20' }, effort: { impl: 'high' }, now: NOW })
    for (const s of chains.impl) {
      const offersHigh = CATALOG.some((e) => e.model === s.model && e.effort === 'high')
      if (offersHigh) expect(s.effort).toBe('high')
    }
    expect(chains.impl.map(tag)).toContain('gpt-6-astra(high)')
    // sem fixar, o Astra entra em medium
    expect(buildChains({ plans: { claude: 'max20', codex: 'pro20' }, now: NOW }).chains.impl.map(tag)).toContain('gpt-6-astra(medium)')
  })

  test('CA8: Claude em 95% no começo da semana passa o código comum para outra empresa e o porquê cita a cota projetada', () => {
    const plans = { claude: 'max20', codex: 'plus' }
    expect(buildChains({ plans, now: NOW }).chains.impl[0].family).toBe('claude')
    const { chains, why } = buildChains({
      plans, quota: { claude: { used: 95, resets_at: '2026-09-27T12:00:00Z', source: 'official' } }, now: NOW,
    })
    expect(chains.impl[0].family).toBe('codex')
    const claudeWhy = why.impl.find((w) => /Opus|Fable|Sonnet|Haiku/.test(w))!
    expect(claudeWhy).toContain('cota projetada até a renovação: 950% (oficial)')
  })

  test('CA9: leitura manual de 40% do Google vale como origem manual e pesa na nota', () => {
    const plans = { agy: 'ai_pro' }
    const manual = { used: 40, resets_at: '2026-09-28T00:00:00Z', source: 'manual' as const }
    const { why } = buildChains({ plans, quota: { agy: manual }, now: NOW })
    expect(why.impl[0]).toContain('(manual)')
    expect(buildChains({ plans, now: NOW }).why.impl[0]).toContain('estimada pelo plano')
  })
})
