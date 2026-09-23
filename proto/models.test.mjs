// node --test proto/models.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChains, measure, pressure, PLANS, CATALOG } from './models.mjs'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const tier = (family, id) => PLANS[family].tiers.find((t) => t.id === id)
const all = (chains) => Object.values(chains).flat()

test('só entram modelos dos planos escolhidos, fora os bloqueados', () => {
  const { chains } = buildChains({ plans: { codex: 'plus', agy: 'ai_pro' }, blocked: ['gpt-5.6-luna'], now: NOW })
  assert.ok(all(chains).length > 0)
  for (const w of all(chains)) {
    assert.notEqual(w.family, 'claude')
    assert.notEqual(w.model, 'gpt-5.6-luna')
  }
})

test('fila de revisão tem um de cada empresa: quem escrever, sobram dois revisores de fora', () => {
  const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro_lite', agy: 'ultra' }, now: NOW })
  assert.equal(new Set(chains.checker.map((w) => w.family)).size, 3)
  for (const role of ['impl', 'impl_hard', 'impl_light', 'prova']) assert.equal(chains.checker.filter((w) => w.family !== chains[role][0].family).length, 2)
})

test('escada de correção começa no titular de código difícil e só sobe em inteligência', () => {
  const { chains, why } = buildChains({ plans: { claude: 'max20', codex: 'pro_lite', agy: 'ultra' }, now: NOW })
  assert.deepEqual(chains.fix[0], chains.impl_hard[0])
  const climb = chains.fix.filter((w) => !w.reserve), ai = why.fix.slice(0, climb.length).map((w) => Number(/inteligência (\d+)/.exec(w)[1]))
  assert.deepEqual(ai, [...ai].sort((a, b) => a - b))
  assert.ok(climb.length >= 2)
  const spare = chains.fix.at(-1)
  assert.ok(spare.reserve && spare.family !== climb[0].family, 'reserva de outra empresa no fim da escada')
})

test('papel com mínimo alto ainda ganha fila quando nenhum modelo do plano chega lá', () => {
  const { chains } = buildChains({ plans: { agy: 'free' }, now: NOW })
  assert.equal(chains.epics[0]?.model, 'gemini-3.8-flash')
})

test('cota adiantada na semana tira o esforço caro das funções de volume', () => {
  const plans = { claude: 'max20', codex: 'pro_lite', agy: 'ultra' }
  const reset = new Date(NOW + 3.5 * 864e5).toISOString()
  const calm = buildChains({ plans, quota: { claude: { seven_day: { used: 5, resets_at: reset } } }, now: NOW }).chains
  const tight = buildChains({ plans, quota: { claude: { seven_day: { used: 80, resets_at: reset } } }, now: NOW }).chains
  const heavy = (w) => w.family === 'claude' && ['high', 'xhigh', 'max'].includes(w.effort)
  assert.ok(heavy(calm.impl_hard[0]), 'código difícil com cota folgada fica no Opus pensando')
  assert.ok(!heavy(tight.impl[0]))
})

test('tarefa leve vai para modelo mais barato que tarefa difícil, mesmo com cota sobrando', () => {
  const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro_lite', agy: 'ultra' }, now: NOW })
  const cost = (w) => CATALOG.find((e) => e.model === w.model && e.effort === w.effort).cpt
  assert.ok(cost(chains.impl_light[0]) < cost(chains.impl_hard[0]) / 2)
  assert.ok(cost(chains.plan_edit[0]) < cost(chains.plan[0]))
})

test('pressão projeta o gasto até a renovação; API não pesa; sem plano é infinita', () => {
  const half = { seven_day: { used: 40, resets_at: new Date(NOW + 3.5 * 864e5).toISOString() } }
  assert.equal(pressure(tier('claude', 'max20'), half, NOW), 0.8)
  assert.equal(pressure(tier('claude', 'api'), half, NOW), 0)
  assert.equal(pressure(undefined, half, NOW), Infinity)
  assert.ok(pressure(tier('agy', 'ultra'), undefined, NOW) < pressure(tier('agy', 'ai_pro'), undefined, NOW), 'sem leitura, plano maior pesa menos')
})

test('medição liga a chamada de quem escreve ao próximo parecer do revisor', () => {
  const g = measure([
    { type: 'model_call', role: 'implementação', model: 'm1', files: 0, wall_ms: 120000, effort: 'high' },
    { type: 'log', text: 'pediu mudanças: falta teste' },
    { type: 'log', text: 'aprovou: ok' }, // segundo parecer da mesma chamada não conta
    { type: 'model_call', role: 'prova e código', model: 'm1', files: 3 },
    { type: 'log', text: 'aprovou: ok' },
  ]).m1
  assert.deepEqual(g, { calls: 2, approved: 1, reviewed: 2, zero: 1, time: { high: { timed: 1, min: 2 } }, eff: { high: { reviewed: 1, approved: 0 } } }) // a 2ª chamada é da mesma parte: não conta na aprovação por esforço
})
