import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createGitPort } from '../src/git/gitport.js'
import { openIntents } from '../src/journal/fold.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { receiptPath, startingReceipt, withRunning, withTerminal, writeReceipt } from '../src/runner/receipt.js'
import { reconcileAll, reconcileIntent } from '../src/step/reconcile.js'
import { makeRepo, removeRepo } from './helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

let tmpDirs: string[] = []
let repoDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    removeTmpDir(dir)
  }
  tmpDirs = []
  for (const dir of repoDirs) {
    removeRepo(dir)
  }
  repoDirs = []
})

function makeMissionDir(): string {
  const dir = makeTmpDir('ade-reconcile-')
  tmpDirs.push(dir)
  return dir
}

function readEvents(missionDir: string): Array<Record<string, any>> {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

/** Reconstrói o formato de `intent` a partir do evento `step_intent` gravado no journal. */
function loadIntent(missionDir: string, stepId: string): Record<string, any> {
  const events = readEvents(missionDir)
  const open = openIntents(events).find((i) => i.step_id === stepId)
  if (!open) {
    throw new Error('intenção aberta não encontrada: ' + stepId)
  }
  const intentEvent = events.find((ev) => ev.kind === 'step_intent' && ev.seq === open.seq)
  return {
    seq: intentEvent!.seq,
    step_id: intentEvent!.step_id,
    effect_class: intentEvent!.effect_class,
    input_digest: intentEvent!.input_digest,
    intent_context: intentEvent!.intent_context,
    receipt_path: intentEvent!.receipt_path,
    worktree: intentEvent!.worktree,
  }
}

describe('reconciler releases local intents', () => {
  // AC1: intenção aberta de classe `none` é liberada com motivo `pure_read` sem tocar na árvore.
  test('pure_read_intent_is_released', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const restoreTreeSpy = vi.spyOn(gitPort, 'restoreTree')
    const commitSpy = vi.spyOn(gitPort, 'commit')
    const checkpointSpy = vi.spyOn(gitPort, 'checkpoint')
    const treeBefore = await gitPort.worktreeTree()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:read',
      effect_class: 'none',
      input_digest: '0000000000000000',
    })

    const intent = loadIntent(missionDir, 'T042:read')
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir })

    expect(verdict).toEqual({
      step_id: 'T042:read',
      effect_class: 'none',
      verdict: 'released',
      reason: 'pure_read',
      evidence: {},
      result: null,
    })

    // A árvore não foi tocada: nenhum método mutável do GitPort foi chamado e a árvore continua a mesma.
    expect(restoreTreeSpy).not.toHaveBeenCalled()
    expect(commitSpy).not.toHaveBeenCalled()
    expect(checkpointSpy).not.toHaveBeenCalled()
    expect(await gitPort.worktreeTree()).toBe(treeBefore)

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042:read')
    expect(resultEvent?.status).toBe('released')
    expect(resultEvent?.data?.reason).toBe('pure_read')
    expect(openIntents(events)).toEqual([])
  })

  // AC2: intenção aberta de classe `local_write` cuja árvore mudou desde `tree_before` volta à
  // árvore original, é liberada e o motivo é `tree_restored`.
  test('local_write_intent_restores_the_tree_and_is_released', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const treeBefore = await gitPort.worktreeTree()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:write',
      effect_class: 'local_write',
      input_digest: '0000000000000000',
      intent_context: { tree_before: treeBefore },
    })

    writeFileSync(path.join(repo.dir, 'new-file.txt'), 'novo\n')
    expect(await gitPort.worktreeTree()).not.toBe(treeBefore)

    const intent = loadIntent(missionDir, 'T042:write')
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir })

    expect(verdict.verdict).toBe('released')
    expect(verdict.reason).toBe('tree_restored')
    expect(verdict.evidence).toMatchObject({ tree_before: treeBefore })
    expect(await gitPort.worktreeTree()).toBe(treeBefore)

    const events = readEvents(missionDir)
    expect(openIntents(events)).toEqual([])
  })

  // AC2 (complemento): árvore igual a `tree_before` não dispara restauração; motivo é `tree_unchanged`.
  test('local_write_intent_with_untouched_tree_is_released_as_unchanged', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const restoreTreeSpy = vi.spyOn(gitPort, 'restoreTree')
    const treeBefore = await gitPort.worktreeTree()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:noop',
      effect_class: 'local_write',
      input_digest: '0000000000000000',
      intent_context: { tree_before: treeBefore },
    })

    const intent = loadIntent(missionDir, 'T042:noop')
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir })

    expect(verdict.verdict).toBe('released')
    expect(verdict.reason).toBe('tree_unchanged')
    expect(restoreTreeSpy).not.toHaveBeenCalled()
  })

  // AC3: toda decisão do reconciler fecha a intenção com um step_result cujo status é o veredicto
  // e cujo motivo legível fica em data.reason; a intenção deixa de aparecer como aberta.
  test('every_reconcile_decision_is_explained_in_the_journal', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const treeBefore = await gitPort.worktreeTree()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:gate',
      effect_class: 'gate',
      input_digest: '0000000000000000',
      intent_context: { tree_before: treeBefore },
    })

    const beforeEvents = readEvents(missionDir)
    expect(openIntents(beforeEvents).map((i) => i.step_id)).toEqual(['T042:gate'])

    const intent = loadIntent(missionDir, 'T042:gate')
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir })

    const afterEvents = readEvents(missionDir)
    const resultEvent = afterEvents.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042:gate')
    expect(resultEvent?.status).toBe(verdict.verdict)
    expect(typeof resultEvent?.data?.reason).toBe('string')
    expect(resultEvent?.data?.reconciled).toBe(true)
    expect(openIntents(afterEvents).map((i) => i.step_id)).not.toContain('T042:gate')
  })

  // AC2 (reconcileAll sem gitPort explícito): a intenção grava `worktree` no topo do evento e o
  // reconciler usa esse caminho para observar e restaurar a árvore, mesmo sem gitPort injetado.
  test('reconcile_all_without_explicit_git_port_still_restores_the_tree_from_intent_worktree', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const treeBefore = await gitPort.worktreeTree()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:no-port',
      effect_class: 'local_write',
      input_digest: '0000000000000000',
      intent_context: { tree_before: treeBefore },
      worktree: repo.dir,
    })

    writeFileSync(path.join(repo.dir, 'new-file.txt'), 'novo\n')
    expect(await gitPort.worktreeTree()).not.toBe(treeBefore)

    const verdicts = await reconcileAll({ journal, missionDir })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ step_id: 'T042:no-port', verdict: 'released', reason: 'tree_restored' })
    expect(await gitPort.worktreeTree()).toBe(treeBefore)
  })

  // Classe restaurável sem worktree (e sem gitPort injetado): não há como observar a árvore, então
  // a intenção não pode ser fechada como inalterada — segue aberta e nenhum step_result é anexado.
  test('local_write_without_worktree_is_not_released', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:no-worktree',
      effect_class: 'local_write',
      input_digest: '0000000000000000',
      intent_context: { tree_before: 'a'.repeat(40) },
    })

    const intent = loadIntent(missionDir, 'T042:no-worktree')
    await expect(reconcileIntent({ intent, journal, gitPort: null, missionDir })).rejects.toMatchObject({
      code: 'state_integrity',
    })

    const events = readEvents(missionDir)
    expect(events.filter((ev) => ev.kind === 'step_result')).toEqual([])
    expect(openIntents(events).map((i) => i.step_id)).toContain('T042:no-worktree')
  })

  // Classe restaurável sem `tree_before`: não há alvo de comparação nem de restauração, então a
  // intenção segue aberta e nenhum step_result é anexado.
  test('local_write_without_tree_before_is_not_released', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:no-tree-before',
      effect_class: 'local_write',
      input_digest: '0000000000000000',
      worktree: repo.dir,
    })

    const intent = loadIntent(missionDir, 'T042:no-tree-before')
    await expect(reconcileIntent({ intent, journal, gitPort, missionDir })).rejects.toMatchObject({
      code: 'state_integrity',
    })

    const events = readEvents(missionDir)
    expect(events.filter((ev) => ev.kind === 'step_result')).toEqual([])
    expect(openIntents(events).map((i) => i.step_id)).toContain('T042:no-tree-before')
  })

  // Classes fora do escopo desta fatia (local_commit fica na s5) não podem ser liberadas sem
  // evidência: o reconciler recusa reconciliá-las em vez de fechar a intenção silenciosamente.
  test('out_of_scope_effect_classes_are_refused_instead_of_silently_released', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:local-commit',
      effect_class: 'local_commit',
      input_digest: '0000000000000000',
    })

    const intent = loadIntent(missionDir, 'T042:local-commit')
    await expect(reconcileIntent({ intent, journal, gitPort: null, missionDir })).rejects.toThrow(/fora desta fatia/)

    const events = readEvents(missionDir)
    expect(openIntents(events).map((i) => i.step_id)).toContain('T042:local-commit')
  })

  // AC4: `reconcileAll` devolve um veredicto por intenção aberta, na ordem crescente de `seq`.
  test('reconcile_all_walks_open_intents_in_seq_order', async () => {
    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:a',
      effect_class: 'none',
      input_digest: '0000000000000000',
    })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:b',
      effect_class: 'none',
      input_digest: '0000000000000001',
    })

    const verdicts = await reconcileAll({ journal, missionDir, gitPort: null })

    expect(verdicts).toHaveLength(2)
    expect(verdicts.map((v) => v.step_id)).toEqual(['T042:a', 'T042:b'])

    const events = readEvents(missionDir)
    expect(openIntents(events)).toEqual([])
  })
})

describe('reconciler handles model_call', () => {
  const REQUEST = {
    unit: 'T042',
    authorization: 'maker',
    cwd: '.',
    argv: ['node', 'x.js'],
    timeout: 60,
    result_file: 'r.json',
  }

  // AC1: sem recibo em disco, a intenção model_call é liberada sem cobrança e sem checkpoint.
  test('model_call_without_receipt_is_released_without_charge', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const dirtyPathsSpy = vi.spyOn(gitPort, 'dirtyPaths')
    const checkpointSpy = vi.spyOn(gitPort, 'checkpoint')

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-no-receipt',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
    })

    const intent = loadIntent(missionDir, 'T042-model-call-no-receipt')
    const deps = { isAlive: vi.fn(() => false), getStartTime: vi.fn(async () => null) }
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir, deps })

    expect(verdict.verdict).toBe('released')
    expect(verdict.reason).toBe('receipt_no_dispatch')
    expect(verdict.evidence).toMatchObject({ charge: 'released', receipt_state: null })
    expect(dirtyPathsSpy).not.toHaveBeenCalled()
    expect(checkpointSpy).not.toHaveBeenCalled()

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042-model-call-no-receipt')
    expect(resultEvent?.status).toBe('released')
    expect(resultEvent?.data?.reason).toBe('receipt_no_dispatch')
    expect(openIntents(events)).toEqual([])
  })

  // AC1 (complemento): recibo `starting` sem process_fingerprint também é liberado sem consultar
  // o worktree.
  test('model_call_starting_without_fingerprint_is_released', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const dirtyPathsSpy = vi.spyOn(gitPort, 'dirtyPaths')

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-starting',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
    })

    const receipt = startingReceipt({
      missionId: 'mission-1',
      stepId: 'T042-model-call-starting',
      request: { ...REQUEST, cwd: repo.dir, result_file: path.join(missionDir, 'r.json') },
      now: () => '2026-01-01T00:00:00.000Z',
    })
    writeReceipt(receiptPath(missionDir, 'T042-model-call-starting'), receipt)

    const intent = loadIntent(missionDir, 'T042-model-call-starting')
    const deps = { isAlive: vi.fn(() => false), getStartTime: vi.fn(async () => null) }
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir, deps })

    expect(verdict.verdict).toBe('released')
    expect(verdict.reason).toBe('receipt_no_dispatch')
    expect(verdict.evidence).toMatchObject({ charge: 'released', receipt_state: 'starting' })
    expect(dirtyPathsSpy).not.toHaveBeenCalled()
  })

  // AC2: recibo em estado terminal com worktree sujo fecha como ambiguous/call_consumed, cobrado,
  // e a evidência traz a referência do checkpoint criado sobre a árvore suja.
  test('model_call_with_terminal_receipt_is_ambiguous_and_checkpoints_the_dirty_tree', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-terminal',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
    })

    let receipt = startingReceipt({
      missionId: 'mission-1',
      stepId: 'T042-model-call-terminal',
      request: { ...REQUEST, cwd: repo.dir, result_file: path.join(missionDir, 'r.json') },
      now: () => '2026-01-01T00:00:00.000Z',
    })
    receipt = withRunning(
      receipt,
      { pid: 4242, start_time: '2026-01-01T00:00:00.000Z', host: 'host-1' },
      '2026-01-01T00:00:01.000Z',
    )
    receipt = withTerminal(receipt, 'exited', { exitCode: 0, nowIso: '2026-01-01T00:00:02.000Z' })
    writeReceipt(receiptPath(missionDir, 'T042-model-call-terminal'), receipt)

    writeFileSync(path.join(repo.dir, 'new-file.txt'), 'novo\n')

    const intent = loadIntent(missionDir, 'T042-model-call-terminal')
    const deps = { isAlive: vi.fn(() => false), getStartTime: vi.fn(async () => null) }
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir, deps })

    expect(verdict.verdict).toBe('ambiguous')
    expect(verdict.reason).toBe('call_consumed')
    expect(verdict.evidence.charge).toBe('charged')
    expect(typeof verdict.evidence.checkpoint_ref).toBe('string')
    expect(verdict.evidence.checkpoint_ref?.startsWith('refs/ade/checkpoints/')).toBe(true)

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042-model-call-terminal')
    expect(resultEvent?.status).toBe('ambiguous')
    expect(resultEvent?.data?.reason).toBe('call_consumed')
    expect(openIntents(events)).toEqual([])
  })

  // AC3: recibo `running` com pid vivo mas horário de início diferente do gravado é ambiguous com
  // motivo pid_fingerprint_mismatch; nenhum resultado é adotado.
  test('reconcile_rejects_pid_reuse_via_fingerprint_mismatch', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const checkpointSpy = vi.spyOn(gitPort, 'checkpoint')

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-fingerprint',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
    })

    let receipt = startingReceipt({
      missionId: 'mission-1',
      stepId: 'T042-model-call-fingerprint',
      request: { ...REQUEST, cwd: repo.dir, result_file: path.join(missionDir, 'r.json') },
      now: () => '2026-01-01T00:00:00.000Z',
    })
    receipt = withRunning(
      receipt,
      { pid: 4242, start_time: '2026-01-01T00:00:00.000Z', host: 'host-1' },
      '2026-01-01T00:00:01.000Z',
    )
    writeReceipt(receiptPath(missionDir, 'T042-model-call-fingerprint'), receipt)

    const intent = loadIntent(missionDir, 'T042-model-call-fingerprint')
    const deps = {
      isAlive: vi.fn(() => true),
      getStartTime: vi.fn(async () => '2026-01-01T00:00:09.000Z'),
    }
    const verdict = await reconcileIntent({ intent, journal, gitPort, missionDir, deps })

    expect(verdict.verdict).toBe('ambiguous')
    expect(verdict.reason).toBe('pid_fingerprint_mismatch')
    expect(verdict.result).toBeNull()
    expect(deps.isAlive).toHaveBeenCalledWith(4242)
    expect(deps.getStartTime).toHaveBeenCalledWith(4242)
    expect(checkpointSpy).not.toHaveBeenCalled()

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042-model-call-fingerprint')
    expect(resultEvent?.status).toBe('ambiguous')
    expect(resultEvent?.data?.reason).toBe('pid_fingerprint_mismatch')
  })

  // AC4: HEAD divergente do head_before fecha a intenção como ambiguous/head_moved e rejeita com
  // StateIntegrityError antes de olhar o recibo; reconcileAll não segue para as intenções seguintes.
  test('model_call_that_moved_head_before_the_crash_stops_the_batch', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const headBefore = await gitPort.headInfo()

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-head-moved',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
      intent_context: { head_before: headBefore.commit, branch_before: headBefore.branch },
    })
    await journal.append({
      kind: 'step_intent',
      step_id: 'T042:after-crash',
      effect_class: 'none',
      input_digest: '0000000000000001',
    })

    repo.git(['commit', '--allow-empty', '-m', 'outro'])

    await expect(reconcileAll({ journal, missionDir, gitPort })).rejects.toMatchObject({ code: 'state_integrity' })

    const events = readEvents(missionDir)
    const resultEvent = events.find((ev) => ev.kind === 'step_result' && ev.step_id === 'T042-model-call-head-moved')
    expect(resultEvent?.status).toBe('ambiguous')
    expect(resultEvent?.data?.reason).toBe('head_moved')

    const open = openIntents(events).map((i) => i.step_id)
    expect(open).not.toContain('T042-model-call-head-moved')
    expect(open).toContain('T042:after-crash')

    const resultEventEvidence = resultEvent?.data?.evidence
    expect(resultEventEvidence).toMatchObject({ receipt_state: null, receipt_path: expect.any(String) })
  })

  // Recibo corrompido no disco não pode ser confundido com ausência de despacho: o erro de
  // leitura tem de propagar, e a intenção continua aberta em vez de ser liberada sem cobrança.
  test('model_call_with_corrupt_receipt_propagates_instead_of_releasing', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const gitPort = createGitPort({ worktreeDir: repo.dir })
    const checkpointSpy = vi.spyOn(gitPort, 'checkpoint')

    const missionDir = makeMissionDir()
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T042-model-call-corrupt-receipt',
      effect_class: 'model_call',
      input_digest: '0000000000000000',
    })

    const file = receiptPath(missionDir, 'T042-model-call-corrupt-receipt')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'isto não é json{{{')

    const intent = loadIntent(missionDir, 'T042-model-call-corrupt-receipt')
    const deps = { isAlive: vi.fn(() => false), getStartTime: vi.fn(async () => null) }

    await expect(reconcileIntent({ intent, journal, gitPort, missionDir, deps })).rejects.toMatchObject({
      code: 'receipt_corrupt',
    })
    expect(checkpointSpy).not.toHaveBeenCalled()

    const events = readEvents(missionDir)
    expect(events.filter((ev) => ev.kind === 'step_result')).toEqual([])
    expect(openIntents(events).map((i) => i.step_id)).toContain('T042-model-call-corrupt-receipt')
  })
})
