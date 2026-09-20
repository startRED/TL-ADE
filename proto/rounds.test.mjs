// node --test proto/rounds.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { makerTurns, preexistingReds, truncated } from './rounds.mjs'

const t = (name, status, message = '') => ({ name, status, message })

test('vermelha antiga é reconhecida mesmo misturada com vermelha nova', () => {
  const before = [t('a', 'failed'), t('b', 'passed'), t('c', 'passed')]
  const after = { tests: [t('a', 'failed'), t('b', 'failed', 'Test timed out in 5000ms'), t('c', 'passed')] }
  assert.deepEqual(preexistingReds(after, before), ['a'])
})

test('sem vermelha antiga devolve lista vazia', () => {
  assert.deepEqual(preexistingReds({ tests: [t('b', 'failed')] }, [t('b', 'passed')]), [])
  assert.deepEqual(preexistingReds({ tests: [] }, [t('a', 'failed')]), [])
  assert.deepEqual(preexistingReds(null, [t('a', 'failed')]), [])
})

test('sem ponto de partida não acusa nada', () => {
  assert.deepEqual(preexistingReds({ tests: [t('a', 'failed')] }, []), [])
})

test('erro de teto de turnos é corte, não defeito', () => {
  assert.equal(truncated({ subtype: 'error_max_turns', num_turns: 21 }, 20), true)
})

test('chamada que gastou o teto conta como corte mesmo sem o subtype (codex, agy)', () => {
  assert.equal(truncated({ num_turns: 30 }, 30), true)
  assert.equal(truncated({ num_turns: 12 }, 30), false)
})

test('chamada sem resultado ou sem teto não é corte', () => {
  assert.equal(truncated(null, 30), false)
  assert.equal(truncated({ num_turns: 0 }, 0), false)
})

test('escalar nunca dá menos turnos que a rodada normal', () => {
  assert.ok(makerTurns({ escalate: true }) >= makerTurns({}))
})

test('quem foi cortado repete com folga', () => {
  assert.ok(makerTurns({ wasTruncated: true }) > makerTurns({ escalate: true }))
})
