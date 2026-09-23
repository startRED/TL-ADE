import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalize, digest16 } from '../../../src/journal/canonical.ts'
import { openJournal, readJournal } from '../../../src/journal/journal.ts'
import { runCase } from './_caso.mjs'

async function withJournal(fn) {
  const missionDir = mkdtempSync(path.join(os.tmpdir(), 'ade-dogfood-journal-'))
  try {
    const journal = openJournal({ missionDir, runtimeStamp: '1:aa:bb', now: () => new Date('2026-09-22T00:00:00Z') })
    for (let i = 0; i < 3; i++) {
      await journal.append({ kind: 'note' })
    }
    await fn(path.join(missionDir, 'journal.jsonl'))
  } finally {
    rmSync(missionDir, { recursive: true, force: true })
  }
}

await runCase({
  async 'cadeia-de-hash-encadeada'() {
    await withJournal((file) => {
      const { events, tornTail } = readJournal(file)
      assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
      assert.equal(tornTail, null)
      assert.notEqual(events[1].prev, events[2].prev)
    })
  },
  async 'cauda-rasgada-detectada'() {
    await withJournal((file) => {
      appendFileSync(file, '{"seq":4')
      const { events, tornTail } = readJournal(file)
      assert.equal(events.length, 3)
      assert.equal(tornTail.line, 4)
    })
  },
  async 'adulteracao-no-meio-recusada'() {
    await withJournal((file) => {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines[1] = lines[1].replace('"kind":"note"', '"kind":"nota"')
      writeFileSync(file, lines.join('\n'))
      assert.throws(() => readJournal(file), (err) => err?.exitCode === 2)
    })
  },
  async 'canonico-independe-da-ordem'() {
    assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}')
    assert.equal(digest16({ b: 1, a: 2 }), digest16({ a: 2, b: 1 }))
  },
})
