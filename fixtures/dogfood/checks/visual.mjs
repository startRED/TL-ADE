import assert from 'node:assert/strict'
import { inferSurfaceMode } from '../../../src/visual/design-brief.ts'
import { calculateRenormalizedFinal, evaluateCutoff } from '../../../src/visual/judge.ts'
import { runCase } from './_caso.mjs'

const criteria = (scores) => Object.entries(scores).map(([id, score]) => ({ id, score, weight: 1 }))

await runCase({
  async 'corte-aprova-nota-alta'() {
    const c = criteria({ specificity: 8, hierarchy: 8, typography: 8, color: 8 })
    assert.equal(evaluateCutoff(c, calculateRenormalizedFinal(c), []), 'pass')
  },
  async 'corte-refaz-especificidade-baixa'() {
    const c = criteria({ specificity: 6.5, hierarchy: 9, typography: 9, color: 9 })
    assert.equal(evaluateCutoff(c, calculateRenormalizedFinal(c), []), 'rework')
  },
  async 'corte-refaz-defeito-critico'() {
    const c = criteria({ specificity: 9, hierarchy: 9, typography: 9, color: 9 })
    assert.equal(evaluateCutoff(c, 9, [{ severity: 'critical' }]), 'rework')
  },
  async 'modo-da-superficie-pelo-pedido'() {
    assert.equal(inferSurfaceMode('painel de monitoramento'), 'operate')
    assert.equal(inferSurfaceMode('artigo do blog'), 'read')
    assert.equal(inferSurfaceMode('página de vendas'), 'persuade')
  },
})
