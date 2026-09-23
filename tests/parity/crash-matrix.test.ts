import { spawnSync } from 'node:child_process'
import fs, { utimesSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BIN_ADE,
  cleanupTmpDirs,
  readCounter,
  setupE2E,
} from './fixtures/e2e-fixture.ts'

export const POINTS = [
  'before_spawn',
  'after_maker_effect',
  'before_contain',
  'after_contain',
  'before_commit',
  'after_commit',
] as const

export function readEvents(missionDir: string): any[] {
  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) return []
  return fs
    .readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function branchCount(repoDir: string): string {
  const res = spawnSync('git', ['rev-list', '--count', 'HEAD..ade/mission-1/ADE-T1'], {
    cwd: repoDir,
    encoding: 'utf8',
  })
  return (res.stdout ?? '').trim()
}

export function runCell(point: (typeof POINTS)[number], actor: 'engine' | 'worker') {
  const fixture = setupE2E()
  const res1 = spawnSync(
    process.execPath,
    [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
    { env: { ...fixture.env, ADE_FAULT: point }, encoding: 'utf8' },
  )
  expect(res1.status).not.toBe(0)

  if (actor === 'worker') {
    const t = new Date(Date.now() - 60_000)
    utimesSync(path.join(fixture.missionDir, 'lease', 'heartbeat'), t, t)
  }

  const res2 = spawnSync(
    process.execPath,
    [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
    { env: fixture.env, encoding: 'utf8' },
  )

  return {
    fixture,
    res1,
    res2,
    events: readEvents(fixture.missionDir),
  }
}

afterEach(() => {
  cleanupTmpDirs()
})

function verifyMatrixCell(point: (typeof POINTS)[number], actor: 'engine' | 'worker') {
  const { fixture, res1, res2, events } = runCell(point, actor)

  expect(res2.status).toBe(0)
  expect(branchCount(fixture.repo.dir)).toBe('0')
  expect(readCounter(fixture.scenarioDir, 'maker')).toBe(1)

  const commitStepResults = events.filter(
    (e) =>
      e.kind === 'step_result' &&
      (e.step_id === 'ADE-T1:commit' || e.data?.step_id === 'ADE-T1:commit'),
  )
  expect(commitStepResults).toHaveLength(1)

  const storyDoneEvents = events.filter(
    (e) => e.kind === 'story_done' &&
      (e.data?.status === 'committed' || e.data?.status === 'delivered'),
  )
  expect(storyDoneEvents).toHaveLength(1)

  const leaseAdopted = events.find((e) => e.kind === 'lease_adopted')
  expect(leaseAdopted).toBeDefined()
  expect(leaseAdopted?.data?.previous_owner?.pid).toBe(res1.pid)
  if (actor === 'worker') {
    expect(leaseAdopted?.data?.reason).toBe('heartbeat_expired')
    expect(leaseAdopted?.data?.heartbeat_age_ms).toBeGreaterThanOrEqual(15_000)
  } else {
    expect(leaseAdopted?.data?.reason).toBe('owner_dead')
  }

  const storyResumed = events.find((e) => e.kind === 'story_resumed')
  expect(storyResumed).toBeDefined()
  expect(storyResumed?.data?.reason).toBe('story_started_in_journal')
}

describe('crash_matrix', () => {
  test('engine_before_spawn', () => verifyMatrixCell('before_spawn', 'engine'), 120_000)
  test('worker_before_spawn', () => verifyMatrixCell('before_spawn', 'worker'), 120_000)
  test('engine_after_maker_effect', () => verifyMatrixCell('after_maker_effect', 'engine'), 120_000)
  test('worker_after_maker_effect', () => verifyMatrixCell('after_maker_effect', 'worker'), 120_000)
  test('engine_before_contain', () => verifyMatrixCell('before_contain', 'engine'), 120_000)
  test('worker_before_contain', () => verifyMatrixCell('before_contain', 'worker'), 120_000)
  test('engine_after_contain', () => verifyMatrixCell('after_contain', 'engine'), 120_000)
  test('worker_after_contain', () => verifyMatrixCell('after_contain', 'worker'), 120_000)
  test('engine_before_commit', () => verifyMatrixCell('before_commit', 'engine'), 120_000)
  test('worker_before_commit', () => verifyMatrixCell('before_commit', 'worker'), 120_000)
  test('engine_after_commit', () => verifyMatrixCell('after_commit', 'engine'), 120_000)
  test('worker_after_commit', () => verifyMatrixCell('after_commit', 'worker'), 120_000)
})

