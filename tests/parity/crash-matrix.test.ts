/* eslint-disable unicorn/no-thenable */
import { spawnSync } from 'node:child_process'
import fs, { utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { heartbeatAgeMs } from '../../src/cli/run.js'
import {
  BIN_ADE,
  cleanupTmpDirs,
  readCounter,
  setupE2E,
} from './fixtures/e2e-fixture.js'

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

describe('crash_matrix_resumes_without_repeating_effects', () => {
  for (const point of POINTS) {
    test(
      `crash_${point}_engine_resumes_without_repeating_effects`,
      () => {
        const { fixture, res1, res2, events } = runCell(point, 'engine')

        expect(res2.status).toBe(0)
        expect(branchCount(fixture.repo.dir)).toBe('1')
        expect(readCounter(fixture.scenarioDir, 'maker')).toBe(1)

        const commitStepResults = events.filter(
          (e) =>
            e.kind === 'step_result' &&
            (e.step_id === 'ADE-T1:commit' || e.data?.step_id === 'ADE-T1:commit'),
        )
        expect(commitStepResults).toHaveLength(1)

        const storyDoneEvents = events.filter(
          (e) => e.kind === 'story_done' && e.data?.status === 'committed',
        )
        expect(storyDoneEvents).toHaveLength(1)

        const leaseAdopted = events.find((e) => e.kind === 'lease_adopted')
        expect(leaseAdopted).toBeDefined()
        expect(leaseAdopted?.data?.previous_owner?.pid).toBe(res1.pid)
        expect(leaseAdopted?.data?.reason).toBe('owner_dead')

        const storyResumed = events.find((e) => e.kind === 'story_resumed')
        expect(storyResumed).toBeDefined()
        expect(storyResumed?.data?.reason).toBe('story_started_in_journal')
      },
      120_000,
    )
  }
})

describe('crash_matrix_worker_cells', () => {
  for (const point of POINTS) {
    test(
      `crash_${point}_worker_resumes_without_repeating_effects`,
      () => {
        const { fixture, res1, res2, events } = runCell(point, 'worker')

        expect(res2.status).toBe(0)
        expect(branchCount(fixture.repo.dir)).toBe('1')
        expect(readCounter(fixture.scenarioDir, 'maker')).toBe(1)

        const commitStepResults = events.filter(
          (e) =>
            e.kind === 'step_result' &&
            (e.step_id === 'ADE-T1:commit' || e.data?.step_id === 'ADE-T1:commit'),
        )
        expect(commitStepResults).toHaveLength(1)

        const storyDoneEvents = events.filter(
          (e) => e.kind === 'story_done' && e.data?.status === 'committed',
        )
        expect(storyDoneEvents).toHaveLength(1)

        const leaseAdopted = events.find((e) => e.kind === 'lease_adopted')
        expect(leaseAdopted).toBeDefined()
        expect(leaseAdopted?.data?.previous_owner?.pid).toBe(res1.pid)
        expect(leaseAdopted?.data?.reason).toBe('heartbeat_expired')
        expect(leaseAdopted?.data?.heartbeat_age_ms).toBeGreaterThanOrEqual(15_000)

        const storyResumed = events.find((e) => e.kind === 'story_resumed')
        expect(storyResumed).toBeDefined()
        expect(storyResumed?.data?.reason).toBe('story_started_in_journal')
      },
      120_000,
    )
  }
})

describe('heartbeatAgeMs', () => {
  test('propagates non-ENOENT errors instead of treating them as a missing heartbeat', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-heartbeat-'))
    const missionDir = path.join(tmpDir, 'mission')
    fs.mkdirSync(missionDir, { recursive: true })

    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw eacces
    })

    try {
      expect(() => heartbeatAgeMs(missionDir)).toThrow(
        expect.objectContaining({ code: 'EACCES' }),
      )
    } finally {
      statSpy.mockRestore()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

