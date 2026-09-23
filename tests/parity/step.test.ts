import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createGitPort } from '../../src/git/gitport.ts'
import { digest16 } from '../../src/journal/canonical.ts'
import { openJournal, readJournal } from '../../src/journal/journal.ts'
import { verifyDelivery } from '../../src/step/reconcile.ts'
import { createStepRunner } from '../../src/step/step.ts'
import { makeRepo, removeRepo } from '../helpers/git-repo.ts'

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

describe('resume from a fixed journal (local_commit and model_call reuse)', () => {
  // Journal com step_result ok de model_call para input_digest de {pack:'v1'}: retomar o mesmo
  // step_id com pack recompilado ({pack:'v2'}) reusa o veredicto gravado e não redispara o efeito.
  test('resume_after_commit_with_changed_pack_does_not_redispatch', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const { step } = createStepRunner({ journal, missionDir, gitPort: null, env: {} })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'v1' }),
    })
    await journal.append({
      kind: 'step_result',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'v1' }),
      status: 'ok',
      result: { ok: true },
    })

    const result = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v2' } },
      () => {
        throw new Error('não deveria rodar')
      },
    )

    expect(result.status).toBe('ok')
    expect(result.reused).toBe(true)
  })

  // Journal sem step_result ok para 'T042:commit' (só a revisão foi aprovada): a entrega não
  // acontece e o trabalho é encaminhado ao operador, sem consultar o Git.
  test('approved_work_without_local_commit_is_handed_to_the_operator', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:r1:review',
      effect_class: 'gate',
      input_digest: digest16({ review: true }),
    })
    await journal.append({
      kind: 'step_result',
      step_id: 'T042:r1:review',
      effect_class: 'gate',
      input_digest: digest16({ review: true }),
      status: 'ok',
      result: { approved: true },
    })

    const events = readEvents(missionDir)
    const gitPort = {
      run: vi.fn(async () => {
        throw new Error('não deveria consultar o Git')
      }),
    }

    const delivery = await verifyDelivery({ events, gitPort, stepId: 'T042:commit' })

    expect(delivery).toEqual({
      delivered: false,
      reason: 'no_local_commit',
      commit: null,
      handoff: 'awaiting_operator',
    })
    expect(gitPort.run).not.toHaveBeenCalled()
  })

  // Commit journalado como ok que deixou de ser alcançável do HEAD após `git commit --amend`:
  // a entrega é recusada com o SHA original e o trabalho vai ao operador.
  test('amended_commit_is_no_longer_delivered', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    writeFileSync(path.join(repo.dir, 'feature.txt'), 'feature\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit do step'])
    const originalCommit = repo.git(['rev-parse', 'HEAD']).trim()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:commit',
      effect_class: 'local_commit',
      input_digest: digest16({ commit: true }),
    })
    await journal.append({
      kind: 'step_result',
      step_id: 'T042:commit',
      effect_class: 'local_commit',
      input_digest: digest16({ commit: true }),
      status: 'ok',
      result: { commit: originalCommit },
    })

    repo.git(['commit', '--amend', '-m', 'commit do step (emendado)'])

    const events = readEvents(missionDir)
    const gitPort = createGitPort({ worktreeDir: repo.dir })

    const delivery = await verifyDelivery({ events, gitPort, stepId: 'T042:commit' })

    expect(delivery).toEqual({
      delivered: false,
      reason: 'amended_after_journal',
      commit: originalCommit,
      handoff: 'awaiting_operator',
    })
  })

  // Journal com model_call fechado ambiguous/call_consumed e local_commit já ok: retomar o mesmo
  // step_id de model_call não reserva (nem cobra) uma chamada nova; devolve o veredicto gravado.
  test('resume_after_commit_does_not_reserve_new_calls', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const { step } = createStepRunner({ journal, missionDir, gitPort: null, env: {} })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'v1' }),
    })
    await journal.append({
      kind: 'step_result',
      step_id: 'T042:r1:maker',
      effect_class: 'model_call',
      input_digest: digest16({ pack: 'v1' }),
      status: 'ambiguous',
      reason: 'call_consumed',
    })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:commit',
      effect_class: 'local_commit',
      input_digest: digest16({ commit: true }),
    })
    await journal.append({
      kind: 'step_result',
      step_id: 'T042:commit',
      effect_class: 'local_commit',
      input_digest: digest16({ commit: true }),
      status: 'ok',
      result: { commit: 'deadbeef' },
    })

    const result = await step(
      { unit: 'T042', id: 'T042:r1:maker', effect_class: 'model_call', input: { pack: 'v2' } },
      () => {
        throw new Error('não deveria rodar')
      },
    )

    expect(result.status).toBe('ambiguous')
    expect(result.reused).toBe(true)
  })
})
