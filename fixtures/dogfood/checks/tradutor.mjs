import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildInterview, classifyIntent, compileIntent } from '../../../src/intent/compiler.ts'
import { runCase } from './_caso.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../intent/${name}.json`, import.meta.url), 'utf8'))

await runCase({
  async 'pedido-trivial-sem-modelo'() {
    const f = fixture('fast-lane-trivial')
    let calls = 0
    const r = await classifyIntent({ request: f.request, discovery: f.discovery }, () => calls++)
    assert.equal(r.complexity, 'trivial')
    assert.equal(r.source, 'deterministic')
    assert.ok(r.confidence >= 0.8)
    assert.equal(calls, 0)
  },
  async 'superficie-critica-auth'() {
    const f = fixture('critical-surface')
    const { contracts } = await compileIntent({ request: f.request, discovery: f.discovery })
    assert.equal(contracts[0].risk.level, 'critical')
    assert.ok(contracts[0].risk.surfaces.includes('auth'))
  },
  async 'entrevista-descarta-pergunta-respondivel'() {
    const f = fixture('refused-question')
    const qs = buildInterview({ unknowns: f.unknowns, discovery: f.discovery, repoIr: f.repoIr, maxQuestions: 5 })
    assert.equal(qs.some((q) => q.text.includes('runner de teste')), false)
    assert.equal(qs.some((q) => q.text.includes('timeout padrão')), true)
  },
  async 'pedido-vazio-recusado'() {
    await assert.rejects(compileIntent({ request: '   ' }), TypeError)
  },
})
