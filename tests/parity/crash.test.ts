import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createGitPort } from '../../src/git/gitport.js'
import { openJournal, readJournal } from '../../src/journal/journal.js'
import { receiptPath, startingReceipt, withRunning, withTerminal, writeReceipt } from '../../src/runner/receipt.js'
import { acquireLease } from '../../src/lease/lease.js'
import { reconcileAll, verifyDelivery } from '../../src/step/reconcile.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'
import { BIN_ADE, cleanupTmpDirs, readCounter, setupE2E } from './fixtures/e2e-fixture.js'

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
  cleanupTmpDirs()
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

async function interruptedStory() {
  const fixture = setupE2E()
  const args = [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir]
  const crash = spawnSync(process.execPath, args, {
    env: { ...fixture.env, ADE_FAULT: 'before_spawn' },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: 120_000,
  })
  expect(wasAborted(crash), crash.stderr || String(crash.error)).toBe(true)
  const started = readEvents(fixture.missionDir).find((e) => e.kind === 'story_started')
  expect(started).toBeDefined()
  const gitPort = createGitPort({ worktreeDir: started?.data.worktree_dir })
  const tree = await gitPort.worktreeTree()
  const head = await gitPort.headInfo()
  return { ...fixture, args, gitPort, tree, head }
}

describe('crash durability (child process aborts)', () => {
  test('command_reconciliation_uses_story_worktree_and_sanitized_receipt', async () => {
    const base = setupRepo()
    const story = setupRepo()
    const missionDir = setupMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    try {
      await journal.append({ kind: 'story_started', data: {
        unit: 'T042', worktree_dir: story.dir, tree_before: story.git(['rev-parse', 'HEAD^{tree}']).trim(),
      } })
      await journal.append({ kind: 'step_intent', unit: 'T042', step_id: 'T042:r1:maker', effect_class: 'model_call' })
      const receipt = startingReceipt({ missionId: 'mission-1', stepId: 'T042_r1_maker', request: {
        unit: 'T042', authorization: 'maker', cwd: story.dir, argv: ['node', 'fake.js'],
        timeout: 60, result_file: path.join(missionDir, 'result.json'),
      } })
      writeReceipt(receiptPath(missionDir, 'T042_r1_maker'), withTerminal(
        withRunning(receipt, { pid: process.pid, start_time: null, host: 'test' }),
        'exited', { exitCode: 0 },
      ))
      writeFileSync(path.join(story.dir, 'maker.txt'), 'obra do maker\n')
      const basePort = createGitPort({ worktreeDir: base.dir })
      const [decision] = await reconcileAll({ journal, missionDir, gitPort: basePort })
      expect(decision?.verdict).toBe('ok')
      expect(decision?.reason).toBe('call_consumed')
      const checkpoint = decision?.evidence.checkpoint_ref
      expect(typeof checkpoint).toBe('string')
      expect(story.git(['show', checkpoint + ':maker.txt'])).toBe('obra do maker\n')
      expect(await basePort.dirtyPaths()).toEqual([])
    } finally {
      await journal.close()
    }
  })

  test('command_rejects_tampered_third_record_without_changing_story_tree', async () => {
    const fixture = await interruptedStory()
    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    const original = lines[2]!
    lines[2] = original.replace(/("kind":")./, '$1x')
    expect(lines[2]).not.toBe(original)
    writeFileSync(journalPath, lines.join('\n'))
    const command = spawnSync(process.execPath, fixture.args, {
      env: fixture.env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: 120_000,
    })
    expect(command.status, command.stderr).toBe(2)
    expect(await fixture.gitPort.worktreeTree()).toBe(fixture.tree)
    expect(await fixture.gitPort.headInfo()).toEqual(fixture.head)
    expect(readCounter(fixture.scenarioDir, 'maker')).toBe(0)
  }, 120_000)

  test('command_rejects_live_lease_without_changing_story_tree', async () => {
    const fixture = await interruptedStory()
    const lease = await acquireLease({
      missionDir: fixture.missionDir,
      adoptDeadOwnerWithinTtl: true,
    })
    try {
      const ownerPath = path.join(lease.dir, 'owner.json')
      const owner = readFileSync(ownerPath, 'utf8')
      expect(lease.owner.pid).toBe(process.pid)
      expect(lease.owner.start_time).toBeTruthy()
      const command = spawnSync(process.execPath, fixture.args, {
        env: fixture.env,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: 120_000,
      })
      expect(command.status, command.stderr).toBe(5)
      expect(readFileSync(ownerPath, 'utf8')).toBe(owner)
      expect(await fixture.gitPort.worktreeTree()).toBe(fixture.tree)
      expect(await fixture.gitPort.headInfo()).toEqual(fixture.head)
      expect(readCounter(fixture.scenarioDir, 'maker')).toBe(0)
    } finally {
      await lease.release()
    }
  }, 120_000)

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
  // reconciliar, o veredicto é ok, a chamada conta como cobrada e existe um checkpoint com
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
    expect(verdicts[0].verdict).toBe('ok')
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

  // CA2 & CA3: uso de crash-step.mjs e maker.json para verificar contadores persistidos
  // de maker_calls, commits e story_done após retomada de queda
  test('crash_followed_by_resume_preserves_single_call_commit_and_done_counters', async () => {
    const { repo, missionDir, scenarioDir, planPath, env } = setupE2E()
    const res1 = spawnSync(process.execPath, [FIXTURE, 'command', planPath, repo.dir], {
      env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: 120_000,
    })
    expect(wasAborted(res1), res1.stderr || String(res1.error)).toBe(true)
    expect(readCounter(scenarioDir, 'maker')).toBe(1)
    expect(readEvents(missionDir).filter((e) =>
      e.kind === 'step_result' && e.step_id === 'ADE-T1:r1:maker')).toHaveLength(0)

    const res2 = spawnSync(process.execPath, [BIN_ADE, 'run', '--plan', planPath, '--repo', repo.dir], {
      env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: 120_000,
    })
    expect(res2.status, res2.stderr).toBe(0)

    const events = readEvents(missionDir)
    const makerCalls = readCounter(scenarioDir, 'maker')
    const branch = 'ade/mission-1/ADE-T1'
    const commits = Number(repo.git(['rev-list', '--count', 'HEAD..' + branch]).trim())
    const storyDone = events.filter((e) => e.kind === 'story_done' &&
      (e.data?.status === 'committed' || e.data?.status === 'delivered')).length
    const results = events.filter((e) => e.kind === 'step_result' && e.step_id === 'ADE-T1:r1:maker')
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('ok')
    expect(results[0]?.data?.reason).toBe('call_consumed')
    const checkpoint = results[0]?.data?.evidence?.checkpoint_ref
    expect(typeof checkpoint).toBe('string')
    expect(repo.git(['rev-parse', branch + '^{tree}']).trim()).toBe(
      repo.git(['rev-parse', checkpoint + '^{tree}']).trim(),
    )
    const actions = JSON.parse(readFileSync(path.join(scenarioDir, 'maker.json'), 'utf8'))
    expect(repo.git(['show', branch + ':src/hello.txt'])).toBe(actions[0].files['src/hello.txt'])
    expect(events.filter((e) => e.kind === 'step_result' && e.step_id === 'ADE-T1:commit')).toHaveLength(1)
    expect(makerCalls).toBe(1)
    expect(commits).toBe(0)
    expect(storyDone).toBe(1)
  }, 120_000)
})
