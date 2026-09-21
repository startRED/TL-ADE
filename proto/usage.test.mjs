import test from 'node:test'
import assert from 'node:assert/strict'
import { callRow, parseJournal, usageReport } from './usage.mjs'

const call = (family, role, input, cache, output, extra = {}) => ({ type: 'model_call', ts: '2026-09-21T10:00:00Z', mission: 'm1', family, role, model: `${family}-m`, tokens_in: input, cache_read: cache, tokens_out: output, ...extra })

test('callRow: cota é entrada + cache + saída, e a parte sai pelo nome quando existe', () => {
  const r = callRow(call('agy', 'implementação', 100, 900, 50, { story: 2, story_id: 'v03-s6', files: 3 }))
  assert.equal(r.quota, 1050)
  assert.equal(r.story, 'v03-s6')
  assert.equal(r.files, 3)
})

test('usageReport: soma por família, fatia de cache e cota por arquivo entregue', () => {
  const rep = usageReport([
    call('agy', 'implementação', 100, 900, 0, { files: 2 }),
    call('agy', 'implementação', 100, 900, 0, { files: 0 }),
    call('codex', 'revisão', 50, 50, 0),
  ])
  const agy = rep.by_family.find((g) => g.key === 'agy')
  assert.equal(agy.calls, 2)
  assert.equal(agy.quota, 2000)
  assert.equal(agy.cache_share, 0.9)
  assert.equal(agy.quota_per_file, 1000)
  assert.equal(agy.zero_file_calls, 1)
  assert.equal(rep.by_family.find((g) => g.key === 'codex').quota_per_file, null)
  assert.equal(rep.total.quota, 2100)
})

test('usageReport: filtra por missão e data', () => {
  const evs = [call('agy', 'x', 1, 0, 0), { ...call('agy', 'x', 1, 0, 0), mission: 'm2' }, { ...call('agy', 'x', 1, 0, 0), ts: '2026-09-19T00:00:00Z' }]
  assert.equal(usageReport(evs, { mission: 'm1', since: '2026-09-20' }).calls, 1)
})

test('parseJournal: só model_call, e linha cortada não derruba', () => {
  const text = `${JSON.stringify(call('agy', 'x', 1, 0, 0))}\n{"type":"model_call","fam\n${JSON.stringify({ type: 'log' })}\n`
  assert.equal(parseJournal(text).length, 1)
})
