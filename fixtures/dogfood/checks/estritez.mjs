import assert from 'node:assert/strict'
import { classifyGreen, classifyRed } from '../../../src/evals/classify.ts'
import { validateScenarioStrictness } from '../../../src/evals/strictness.ts'
import { runCase } from './_caso.mjs'

const report = (total, failed) => ({ numTotalTests: total, numPassedTests: total - failed, numFailedTests: failed })

await runCase({
  async 'aditivo-sozinho-recusado'() {
    const r = validateScenarioStrictness({ id: 'C1', evals: [{ kind: 'test', strictness: { mode: 'additive' } }] })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'additive_without_companion')
  },
  async 'aditivo-com-negativo-aceito'() {
    const r = validateScenarioStrictness({
      id: 'C1',
      evals: [
        { kind: 'test', strictness: { mode: 'additive' } },
        { kind: 'negative', strictness: { mode: 'must_fail_before' } },
      ],
    })
    assert.equal(r.ok, true)
  },
  async 'vermelho-por-assercao'() {
    const r = classifyRed({ exitCode: 1, expectExit: 0, timedOut: false, stdout: '', stderr: '', report: report(2, 1) })
    assert.equal(r.red_reason, 'assertion')
    assert.equal(r.num_total_tests, 2)
  },
  async 'verde-sem-alvo-recusado'() {
    const { red_reason } = classifyRed({ exitCode: 0, expectExit: 0, timedOut: false, stdout: '', stderr: '', report: report(0, 0) })
    assert.equal(red_reason, 'missing_target')
    assert.equal(classifyGreen({ red_reason }).verdict, 'refused')
  },
})
