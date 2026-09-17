import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../../src/git/gitport.js'
import { openJournal, readJournal } from '../../src/journal/journal.js'
import { createStepRunner } from '../../src/step/step.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

let repoDirs: string[] = []
let missionDirs: string[] = []

afterEach(() => {
  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  repoDirs = []
  for (const dir of missionDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  missionDirs = []
})

function makeMissionDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-step-parity-'))
  missionDirs.push(dir)
  return dir
}

function readEvents(missionDir: string): Array<Record<string, any>> {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

describe('step head guard parity', () => {
  // AC3: model_call cujo efeito move o HEAD do worktree faz step() rejeitar com
  // erro de código state_integrity e o journal registra step_result com esse
  // status e o motivo head_moved.
  test('worker_that_moves_head_stops_the_batch', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const { step } = createStepRunner({ journal, missionDir, gitPort, env: {} })

    const effectFn = async () => {
      repo.git(['commit', '--allow-empty', '-m', 'worker'])
      return { done: true }
    }

    let caught: any = null
    try {
      await step(
        { unit: 'T042', id: 'T042:worker', effect_class: 'model_call', input: { pack: 'v1' } },
        effectFn,
      )
    } catch (err) {
      caught = err
    }

    expect(caught).not.toBeNull()
    expect(caught.code).toBe('state_integrity')
    expect(caught.exitCode).toBe(4)

    const events = readEvents(missionDir)
    const ultimo = events[events.length - 1]
    expect(ultimo.status).toBe('state_integrity')
    expect(ultimo.data.reason).toBe('head_moved')
  })

  // AC4: model_call que não move o HEAD grava head_before e branch_before em
  // intent_context e devolve resultado normal (reused:false).
  test('worker_that_does_not_move_head_records_head_before_and_branch_before', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])
    const headCommit = repo.git(['rev-parse', 'HEAD']).trim()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const { step } = createStepRunner({ journal, missionDir, gitPort, env: {} })

    const effectFn = async () => ({ done: true })

    const result = await step(
      { unit: 'T042', id: 'T042:calm-worker', effect_class: 'model_call', input: { pack: 'v1' } },
      effectFn,
    )

    expect(result.reused).toBe(false)

    const events = readEvents(missionDir)
    const intentEvent = events.find((ev) => ev.kind === 'step_intent')
    expect(intentEvent).toBeDefined()
    expect(intentEvent!.intent_context.head_before).toBe(headCommit)
    expect(intentEvent!.intent_context.branch_before).toBe('main')
  })
})
