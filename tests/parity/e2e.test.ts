import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { acquireLease } from '../../src/lease/lease.ts'
import * as reportModule from '../../src/cli/report.js'
import { BIN_ADE, cleanupTmpDirs, readCounter, setupE2E } from './fixtures/e2e-fixture.ts'

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
    expect(storyDone?.data?.status).toBe('delivered')
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

  // CA4: Dado dois eventos telemetry de role maker com tokens reported (100/20/500/40/0.0123 e 200/0/0/60/0.02)
  // e um terceiro com source unavailable, quando sumTokensByRole e renderReport rodam,
  // então maker tem calls 3, unavailable_calls 1, input 300, output 100
  // e o relatório contém a linha começando com '| maker | 3 | 1 | 300 | 20 | 500 | 100 | 0.0323 |'
  test('report_sums_tokens_by_role_from_journal', () => {
    const sumTokensByRole = (reportModule as any).sumTokensByRole
    const renderReport = reportModule.renderReport

    const events = [
      {
        kind: 'telemetry',
        unit: 's1',
        data: {
          role: 'maker',
          step_id: 's1:r1:maker',
          tokens: {
            input: 100,
            cache_write: 20,
            cache_read: 500,
            output: 40,
            usd: 0.0123,
            source: 'reported',
          },
        },
      },
      {
        kind: 'telemetry',
        unit: 's2',
        data: {
          role: 'maker',
          step_id: 's2:r1:maker',
          tokens: {
            input: 200,
            cache_write: 0,
            cache_read: 0,
            output: 60,
            usd: 0.02,
            source: 'reported',
          },
        },
      },
      {
        kind: 'telemetry',
        unit: 's3',
        data: {
          role: 'maker',
          step_id: 's3:r1:maker',
          tokens: { source: 'unavailable' },
        },
      },
    ]

    const sums = sumTokensByRole(events)
    expect(sums).toEqual([
      {
        role: 'maker',
        calls: 3,
        unavailable_calls: 1,
        input: 300,
        cache_write: 20,
        cache_read: 500,
        output: 100,
        usd: expect.closeTo(0.0323, 4),
      },
    ])

    const report = renderReport('m1', [{ unit: 's1', status: 'committed' }], sums)
    expect(report).toContain('## Custo por papel')
    expect(report).toContain('| maker | 3 | 1 | 300 | 20 | 500 | 100 | 0.0323 |')

    const quotaUsage = (reportModule as any).sumQuotaUsage(events, new Date('2026-09-20T12:00:00.000Z').getTime())
    const reportWithQuota = renderReport('m1', [{ unit: 's1', status: 'committed' }], sums, quotaUsage)
    expect(reportWithQuota).toContain('## Custo por papel')
    expect(reportWithQuota).toContain('| maker | 3 | 1 | 300 | 20 | 500 | 100 | 0.0323 |')
    expect(reportWithQuota).toContain('## Cota por dia UTC')
    expect(reportWithQuota).toContain('## Janelas de cota')
    expect(reportWithQuota).toContain('## Recibos oficiais')
  })

  test('run_plan_persists_reported_tokens_in_journal_telemetry', async () => {
    const fixture = setupE2E()
    const fakeStdout = JSON.stringify({
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 500,
        output_tokens: 40,
      },
      total_cost_usd: 0.0123,
      structured_output: {
        format_version: 1,
        story_id: 'ADE-T1',
        state: 'done',
        phase: 'green',
        round: 1,
        tree_before: '0123456789abcdef',
        tree_after: 'fedcba9876543210',
        eval_records: [],
        gate_records: [],
        passes: true,
        reason: 'ok',
        sources: ['contract'],
      },
    })
    const makerActions = [
      {
        files: {
          'src/hello.txt': 'ok\n',
        },
        result: {
          format_version: 1,
          story_id: 'ADE-T1',
          state: 'done',
          phase: 'green',
          round: 1,
          tree_before: '0123456789abcdef',
          tree_after: 'fedcba9876543210',
          eval_records: [],
          gate_records: [],
          passes: true,
          reason: 'ok',
          sources: ['contract'],
        },
        stdout: fakeStdout,
      },
    ]
    fs.writeFileSync(
      path.join(fixture.scenarioDir, 'maker.json'),
      JSON.stringify(makerActions, null, 2),
      'utf8',
    )

    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8', maxBuffer: 1_048_576 },
    )
    expect(res.status).toBe(0)

    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))

    const telemetryEvents = events.filter((e) => e.kind === 'telemetry' && e.data.role === 'maker')
    expect(telemetryEvents).toHaveLength(1)
    const telemetry = telemetryEvents[0]
    expect(telemetry.data.unit).toBe('ADE-T1')
    expect(telemetry.data).toMatchObject({
      role: 'maker',
      step_id: 'ADE-T1:r1:maker',
      tokens_in: 100,
      cache_write: 20,
      cache_read: 500,
      tokens_out: 40,
      cost_usd: 0.0123,
      tokens_source: 'reported',
    })
    expect(typeof telemetry.data.duration_ms).toBe('number')
    expect(telemetry.data.duration_ms).toBeGreaterThanOrEqual(0)
  }, 60_000)
})

