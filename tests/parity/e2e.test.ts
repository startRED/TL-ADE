/* eslint-disable unicorn/no-thenable */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { acquireLease } from '../../src/lease/lease.js'
import { BIN_ADE, cleanupTmpDirs, readCounter, setupE2E } from './fixtures/e2e-fixture.js'

afterEach(() => {
  cleanupTmpDirs()
})


describe('e2e parity', () => {
  // CA1: Dado um repositório git real com plan.json de uma story trivial e ADE_FAKE_CLI=1,
  // quando node bin/ade.js run --plan <plan.json> --repo <repo> roda, então o processo sai com 0
  // e a branch ade/mission-1/ADE-T1 tem 1 commit novo.
  test('run_plan_executes_one_trivial_story_to_local_commit', async () => {
    const fixture = setupE2E()
    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res.status).toBe(0)

    const logMsg = fixture.repo.git(['log', 'ade/mission-1/ADE-T1', '-1', '--format=%s']).trim()
    expect(logMsg).toBe('ade(ADE-T1): Trivial Story')

    // Afirma no journal step_result ':red:' e ':green:', contain_result, gates_done e pack_manifest
    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('batch_open')
    expect(kinds).toContain('pack_manifest')
    expect(kinds).toContain('contain_result')
    expect(kinds).toContain('gates_done')
    expect(kinds).toContain('story_done')

    const stepResults = events.filter((e) => e.kind === 'step_result')
    const redStep = stepResults.find((e) => String(e.step_id).includes(':red:'))
    const greenStep = stepResults.find((e) => String(e.step_id).includes(':green:'))
    expect(redStep).toBeDefined()
    expect(greenStep).toBeDefined()

    const storyDone = events.find((e) => e.kind === 'story_done')
    expect(storyDone?.data?.status).toBe('committed')
    expect(typeof storyDone?.data?.commit).toBe('string')
  }, 60_000)

  // CA2: Dado um plano com permitted_effects: ['local_write'], quando ade run roda,
  // então sai com 4 e o contador maker da CLI falsa continua 0.
  test('run_refuses_internal_effect_before_dispatch', async () => {
    const fixture = setupE2E({ permittedEffects: ['local_write'] })
    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res.status).toBe(4)
    expect(res.stderr).toContain('classe interna')
    expect(readCounter(fixture.scenarioDir, 'maker')).toBe(0)

    // node bin/ade.js run (sem --plan) -> status 4 e stderr 'uso: ade run --plan <arquivo> ...'
    const resNoPlan = spawnSync(
      process.execPath,
      [BIN_ADE, 'run'],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(resNoPlan.status).toBe(4)
    expect(resNoPlan.stderr).toContain('uso: ade run --plan <arquivo>')
  }, 60_000)

  // CA3: Dado um journal da missão com uma linha adulterada, quando ade run roda de novo,
  // então sai com 2.
  test('tampered_journal_exits_2', async () => {
    const fixture = setupE2E()
    const res1 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res1.status).toBe(0)

    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(2)

    // Altera 1 caractere na linha 2
    const line2 = lines[1]
    const tamperedLine2 = line2.includes('a') ? line2.replace('a', 'b') : line2.replace('1', '2')
    lines[1] = tamperedLine2
    fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8')

    const res2 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res2.status).toBe(2)
  }, 60_000)

  // CA4: Dado um lease da missão já adquirido por outro dono vivo, quando ade run roda,
  // então sai com 5.
  test('concurrent_lease_exits_5', async () => {
    const fixture = setupE2E()
    const lease = await acquireLease({ missionDir: fixture.missionDir })
    try {
      const res = spawnSync(
        process.execPath,
        [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
        { env: fixture.env, encoding: 'utf8' },
      )
      expect(res.status).toBe(5)
    } finally {
      await lease.release()
    }
  }, 60_000)

  test('fixture_cleanup_removes_tmp_dirs', () => {
    const fixture = setupE2E()
    expect(fs.existsSync(fixture.repo.dir)).toBe(true)
    cleanupTmpDirs()
    expect(fs.existsSync(fixture.repo.dir)).toBe(false)
    expect(() => cleanupTmpDirs()).not.toThrow()
  })
})

