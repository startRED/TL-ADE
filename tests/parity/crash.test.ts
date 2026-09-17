import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../../src/git/gitport.js'
import { openJournal, readJournal } from '../../src/journal/journal.js'
import { receiptPath } from '../../src/runner/receipt.js'
import { reconcileAll, verifyDelivery } from '../../src/step/reconcile.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'
const FIXTURE = fileURLToPath(new URL('../fixtures/crash-step.mjs', import.meta.url))
const MAX_BUFFER = 1 << 26

// process.abort() termina o processo de forma anormal: em POSIX o filho morre por sinal
// (signal: 'SIGABRT', status: null); nesta máquina Windows o mesmo abort chega ao spawnSync
// como status 134 (128 + SIGABRT), medido empiricamente, com signal: null. Um process.exit(1)
// comum nunca produz nenhuma das duas formas, então isso separa abort de saída de erro normal.
function wasAborted(res: ReturnType<typeof spawnSync>): boolean {
  return res.signal === 'SIGABRT' || res.status === 134
}

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
      removeTmpDir(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  missionDirs = []
})

function setupRepo() {
  const repo = makeRepo()
  repoDirs.push(repo.dir)
  writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])
  return repo
}

function setupMissionDir(): string {
  const dir = makeTmpDir('ade-crash-')
  missionDirs.push(dir)
  return dir
}

function readEvents(missionDir: string): Array<Record<string, any>> {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

// Roda o fixture num processo filho de verdade com ADE_FAULT definido, para que o abort
// seja um process.abort() real e não uma simulação em memória.
function runCrashChild(scenario: string, missionDir: string, worktreeDir: string, faultPoint: string) {
  return spawnSync(process.execPath, [FIXTURE, scenario, missionDir, worktreeDir], {
    env: { ...process.env, ADE_FAULT: faultPoint },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
}

describe('crash durability (child process aborts)', () => {
  // AC1: filho abortado depois do step_intent e antes do efeito do model_call; ao reconciliar,
  // o veredicto é released sem cobrança e nenhum recibo foi consumido.
  test('crash_before_maker_effect_releases_the_call', async () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const res = runCrashChild('model_call', missionDir, repo.dir, 'after_intent')
    expect(wasAborted(res)).toBe(true)

    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const verdicts = await reconcileAll({ journal, missionDir, gitPort })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].step_id).toBe('T042:r1:maker')
    expect(verdicts[0].verdict).toBe('released')
    expect(verdicts[0].reason).toBe('receipt_no_dispatch')
    expect(verdicts[0].evidence.charge).toBe('released')
    expect(existsSync(receiptPath(missionDir, 'T042:r1:maker'))).toBe(false)
  })

  // AC2: filho abortado depois do efeito do model_call, com recibo terminal e árvore suja; ao
  // reconciliar, o veredicto é ambiguous, a chamada conta como cobrada e existe um checkpoint com
  // a árvore suja (contendo maker.txt) para continuar dali.
  test('crash_after_maker_effect_consumes_call_and_continues_from_checkpoint', async () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const res = runCrashChild('model_call', missionDir, repo.dir, 'after_effect')
    expect(wasAborted(res)).toBe(true)

    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const verdicts = await reconcileAll({ journal, missionDir, gitPort })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].verdict).toBe('ambiguous')
    expect(verdicts[0].reason).toBe('call_consumed')
    expect(verdicts[0].evidence.charge).toBe('charged')
    expect(typeof verdicts[0].evidence.checkpoint_ref).toBe('string')

    const checkpointRef = verdicts[0].evidence.checkpoint_ref as string
    const treeFromRef = repo.git(['rev-parse', checkpointRef + '^{tree}']).trim()
    expect(treeFromRef).toBe(verdicts[0].evidence.checkpoint_tree)

    const filesInTree = repo.git(['ls-tree', '-r', '--name-only', checkpointRef])
    expect(filesInTree.split('\n')).toContain('maker.txt')
  })

  // AC3: filho abortado depois do commit e antes do resultado; ao reconciliar, o commit existente
  // é adotado e o repositório continua com o mesmo número de commits (nenhum commit é criado de novo).
  test('crash_after_commit_is_reconciled_without_a_second_commit', async () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const res = runCrashChild('commit', missionDir, repo.dir, 'after_effect')
    expect(wasAborted(res)).toBe(true)

    const depoisDoFilho = repo.git(['rev-list', '--count', 'HEAD']).trim()

    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const verdicts = await reconcileAll({ journal, missionDir, gitPort })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].verdict).toBe('ok')
    expect(verdicts[0].reason).toBe('commit_adopted')

    const depoisDaReconciliacao = repo.git(['rev-list', '--count', 'HEAD']).trim()
    expect(depoisDaReconciliacao).toBe(depoisDoFilho)
  })

  // AC4: commit já journalado (step_result ok antes do abort); ao verificar a entrega, ela
  // acontece porque o commit está alcançável a partir do HEAD atual.
  test('crash_after_journaled_commit_resumes_with_that_commit', async () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const res = runCrashChild('commit', missionDir, repo.dir, 'after_result')
    expect(wasAborted(res)).toBe(true)

    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const verdicts = await reconcileAll({ journal, missionDir, gitPort })
    expect(verdicts).toEqual([])

    const events = readEvents(missionDir)
    const delivery = await verifyDelivery({ events, gitPort, stepId: 'T042:commit' })

    expect(delivery.delivered).toBe(true)
    expect(delivery.reason).toBe('commit_on_branch')
  })

  // AC4 (recusa): o mesmo commit journalado, mas emendado antes da verificação; a entrega é
  // recusada porque o commit original deixou de ser alcançável a partir do HEAD.
  test('branch_amended_after_journaled_commit_is_not_delivered', async () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const res = runCrashChild('commit', missionDir, repo.dir, 'after_result')
    expect(wasAborted(res)).toBe(true)

    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })
    await reconcileAll({ journal, missionDir, gitPort })

    repo.git(['commit', '--amend', '-m', 'emendado'])

    const events = readEvents(missionDir)
    const delivery = await verifyDelivery({ events, gitPort, stepId: 'T042:commit' })

    expect(delivery.delivered).toBe(false)
    expect(delivery.reason).toBe('amended_after_journal')
    expect(delivery.handoff).toBe('awaiting_operator')
  })

  // Contrato de interface do fixture: sem ADE_FAULT (ou com um valor que não é nenhum dos três
  // pontos), o step completa normalmente e o processo sai com 0 — nenhum abort é disparado.
  test('child_exits_with_zero_when_no_ade_fault_matches', () => {
    const repo = setupRepo()
    const missionDir = setupMissionDir()

    const env = { ...process.env }
    delete env.ADE_FAULT

    const res = spawnSync(process.execPath, [FIXTURE, 'model_call', missionDir, repo.dir], {
      env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    })

    expect(wasAborted(res)).toBe(false)
    expect(res.status).toBe(0)
    // O fixture grava o recibo do maker num caminho sem dois-pontos (ver comentário em
    // crash-step.mjs); é esse caminho físico, e não receiptPath(missionDir, 'T042:r1:maker'),
    // que existe em disco.
    expect(existsSync(path.join(missionDir, 'jobs', 'T042-r1-maker.json'))).toBe(true)

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042:r1:maker')
    expect(resultEvent?.status).toBe('ok')
  })
})
