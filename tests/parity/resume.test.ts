/* eslint-disable unicorn/no-thenable */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { findStoryStarted } from '../../src/engine/resume.js'
import { BIN_ADE, cleanupTmpDirs, setupE2E } from './fixtures/e2e-fixture.js'

afterEach(() => {
  cleanupTmpDirs()
})

describe('resume parity', () => {
  // CA1: Dado events com dois story_started de ADE-T1 (tree_before 't1' e depois 't2'),
  // quando findStoryStarted(events,'ADE-T1') roda, então devolve {worktree_dir, tree_before:'t2'};
  // com events vazio ou só de outra unidade, devolve null.
  test('find_story_started_returns_latest_for_unit', () => {
    const events = [
      { kind: 'story_started', data: { unit: 'ADE-T1', worktree_dir: '/w', tree_before: 't1' } },
      { kind: 'story_started', data: { unit: 'ADE-T1', worktree_dir: '/w', tree_before: 't2' } },
    ]
    expect(findStoryStarted(events, 'ADE-T1')).toEqual({
      worktree_dir: '/w',
      tree_before: 't2',
    })

    // Borda: events vazio
    expect(findStoryStarted([], 'ADE-T1')).toBeNull()

    // Borda: evento só de outra unidade
    expect(
      findStoryStarted(
        [{ kind: 'story_started', data: { unit: 'ADE-T2', worktree_dir: '/w', tree_before: 't1' } }],
        'ADE-T1',
      ),
    ).toBeNull()

    // Fallback: ev.unit quando ev.data.unit não estiver preenchido
    expect(
      findStoryStarted(
        [{ kind: 'story_started', unit: 'ADE-T1', data: { worktree_dir: '/w3', tree_before: 't3' } }],
        'ADE-T1',
      ),
    ).toEqual({
      worktree_dir: '/w3',
      tree_before: 't3',
    })

    // Incompleto: data sem worktree_dir ou tree_before válidos é ignorado
    expect(
      findStoryStarted(
        [{ kind: 'story_started', data: { unit: 'ADE-T1' } }],
        'ADE-T1',
      ),
    ).toBeNull()

    expect(
      findStoryStarted(
        [{ kind: 'story_started', data: { unit: 'ADE-T1', worktree_dir: '/w' } }],
        'ADE-T1',
      ),
    ).toBeNull()

    expect(
      findStoryStarted(
        [{ kind: 'story_started', data: { unit: 'ADE-T1', tree_before: 't1' } }],
        'ADE-T1',
      ),
    ).toBeNull()

    expect(
      findStoryStarted(
        [
          { kind: 'story_started', data: { unit: 'ADE-T1', worktree_dir: '/w', tree_before: 't1' } },
          { kind: 'story_started', data: { unit: 'ADE-T1' } },
        ],
        'ADE-T1',
      ),
    ).toEqual({
      worktree_dir: '/w',
      tree_before: 't1',
    })
  })

  // CA2: Dado a fixture e2e e um único ade run sem ADE_FAULT, quando o journal é lido,
  // então há exatamente 1 story_started com data.unit 'ADE-T1', data.tree_before
  // casando /^[0-9a-f]{40}$/ e data.worktree_dir existente em disco.
  test('run_journals_story_started_after_prepare', () => {
    const fixture = setupE2E()
    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res.status).toBe(0)

    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))

    const storyStartedEvents = events.filter((e) => e.kind === 'story_started')
    expect(storyStartedEvents).toHaveLength(1)

    const ev = storyStartedEvents[0]
    expect(ev.data?.unit).toBe('ADE-T1')
    expect(ev.data?.tree_before).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof ev.data?.worktree_dir).toBe('string')
    expect(fs.existsSync(ev.data?.worktree_dir)).toBe(true)
  }, 120_000)

  // CA3 e CA4: Dado um primeiro ade run com ADE_FAULT='before_commit' (status diferente de 0),
  // quando um segundo ade run sem ADE_FAULT roda logo em seguida, então sai com 0 e
  // git rev-list --count HEAD..ade/mission-1/ADE-T1 devolve '1'.
  // No journal, há um lease_adopted com data.previous_owner.pid === res1.pid e
  // data.reason 'owner_dead', e um story_resumed com data.reason 'story_started_in_journal'.
  test('second_run_after_fault_adopts_lease_and_resumes', () => {
    const fixture = setupE2E()
    const envWithFault = { ...fixture.env, ADE_FAULT: 'before_commit' }

    // Primeiro run com falha antes do commit
    const res1 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: envWithFault, encoding: 'utf8' },
    )
    expect(res1.status).not.toBe(0)

    // Segundo run sem ADE_FAULT retoma a execução
    const res2 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res2.status).toBe(0)

    const revCount = fixture.repo.git(['rev-list', '--count', 'HEAD..ade/mission-1/ADE-T1']).trim()
    expect(revCount).toBe('1')

    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))

    const leaseAdopted = events.find((e) => e.kind === 'lease_adopted')
    expect(leaseAdopted).toBeDefined()
    expect(leaseAdopted.data?.previous_owner?.pid).toBe(res1.pid)
    expect(leaseAdopted.data?.reason).toBe('owner_dead')

    const storyResumed = events.find((e) => e.kind === 'story_resumed')
    expect(storyResumed).toBeDefined()
    expect(storyResumed.data?.reason).toBe('story_started_in_journal')
  }, 120_000)
})
