// node --test proto/rounds.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { makerTurns, truncated } from './rounds.mjs'

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
