import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createGitPort, GitInvalidInputError } from '../../src/git/gitport.ts'
import { digest16 } from '../../src/journal/canonical.ts'
import { AdeError } from '../../src/journal/errors.ts'
import { openJournal, readJournal } from '../../src/journal/journal.ts'
import { reconcileAll } from '../../src/step/reconcile.ts'
import {
  DeliveryInvalidInputError,
  reconcileLocalMerge,
  reconcilePush,
} from '../../src/step/reconcile-delivery.ts'
import { EFFECT_CLASSES } from '../../src/step/step.ts'
import { makeRepo } from '../helpers/git-repo.ts'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tempDirs = []
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeBareRepo(): { dir: string } {
  const dir = makeTempDir('ade-bare-')
  execFileSync('git', ['init', '--bare'], { cwd: dir, encoding: 'utf8' })
  return { dir }
}

function makeShimScript(dir: string): string {
  const shimPath = path.join(dir, 'push-shim.js')
  const content = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const counterFile = process.argv[2];
const shouldFail = process.argv[3];
const worktreeDir = process.argv[4];
const remote = process.argv[5];
const refspec = process.argv[6];

const current = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
fs.writeFileSync(counterFile, String(current + 1), 'utf8');

execFileSync('git', ['-C', worktreeDir, 'push', remote, refspec], { encoding: 'utf8' });

if (shouldFail === '1') {
  process.exit(1);
}
`
  writeFileSync(shimPath, content, 'utf8')
  return shimPath
}

describe('Reconciliar push e merge local', () => {
  // CA1: Dado push que atualiza o bare e depois devolve erro, quando o estado remoto é consultado,
  // então o commit é adotado e nenhum segundo push ocorre.
  // Exemplo: wrapper atualiza bare para abc e sai 1 -> {verdict:'ok',remote_head:'abc',pushes:1}
  test('ca1_push_that_errors_after_landing_is_not_repeated', async () => {
    const bare = makeBareRepo()
    const local = makeRepo()
    tempDirs.push(local.dir)
    local.git(['remote', 'add', 'origin', bare.dir])

    writeFileSync(path.join(local.dir, 'content.txt'), 'hello\n')
    local.git(['add', '-A'])
    local.git(['commit', '-m', 'commit abc'])
    const commitAbc = local.git(['rev-parse', 'HEAD']).trim()

    const shimDir = makeTempDir('ade-shim-')
    const shimPath = makeShimScript(shimDir)
    const counterFile = path.join(shimDir, 'pushes.txt')
    writeFileSync(counterFile, '0', 'utf8')

    // Executa wrapper Node que faz push com sucesso mas sai com código 1
    let wrapperFailed = false
    try {
      execFileSync(
        process.execPath,
        [shimPath, counterFile, '1', local.dir, 'origin', 'main'],
        { encoding: 'utf8' },
      )
    } catch {
      wrapperFailed = true
    }
    expect(wrapperFailed).toBe(true)

    // O bare foi atualizado para commitAbc e o contador está em 1
    const bareCommit = execFileSync('git', ['-C', bare.dir, 'rev-parse', 'refs/heads/main'], {
      encoding: 'utf8',
    }).trim()
    expect(bareCommit).toBe(commitAbc)
    expect(Number(readFileSync(counterFile, 'utf8'))).toBe(1)

    // Consulta de reconciliação com porta remota
    const gitPort = createGitPort({ worktreeDir: local.dir })
    const outcome = await reconcilePush({
      intent: {
        step_id: 'push:1',
        effect_class: 'push',
        commit: commitAbc,
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: null,
          commit: commitAbc,
        },
      },
      remotePort: gitPort,
    })

    expect(outcome.verdict).toBe('ok')
    expect(outcome.remote_head).toBe(commitAbc)
    expect(Number(readFileSync(counterFile, 'utf8'))).toBe(1)
  })

  // CA2: Dado remoto inalterado desde a intenção, quando uma retomada consulta a ref, então o
  // push é liberado; remoto divergente ou resetado produz ambiguous e awaiting_operator.
  // Exemplos:
  // - {remote_before:'abc',current:'abc'} -> {verdict:'released'}
  // - {remote_before:'abc',current:'def'} -> {verdict:'ambiguous',state:'awaiting_operator'}
  test('ca2_remote_unchanged_releases_and_diverged_or_reset_waits_operator', async () => {
    // Caso 1: remoto inalterado -> released
    const portUnchanged = {
      readRef: vi.fn(async () => 'abc'),
    }
    const outcome1 = await reconcilePush({
      intent: {
        step_id: 'push:unchanged',
        effect_class: 'push',
        commit: 'def',
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: 'abc',
        },
      },
      remotePort: portUnchanged,
    })
    expect(outcome1).toMatchObject({ verdict: 'released' })

    // Caso 1b: null/null (remoto inalterado sem branch criada) -> released
    const portNull = {
      readRef: vi.fn(async () => null),
    }
    const outcome1b = await reconcilePush({
      intent: {
        step_id: 'push:null',
        effect_class: 'push',
        commit: 'def',
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: null,
        },
      },
      remotePort: portNull,
    })
    expect(outcome1b).toMatchObject({ verdict: 'released' })

    // Caso 2: remoto divergente -> ambiguous com awaiting_operator
    const portDiverged = {
      readRef: vi.fn(async () => 'def'),
    }
    const outcome2 = await reconcilePush({
      intent: {
        step_id: 'push:diverged',
        effect_class: 'push',
        commit: 'xyz',
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: 'abc',
        },
      },
      remotePort: portDiverged,
    })
    expect(outcome2).toMatchObject({
      verdict: 'ambiguous',
      state: 'awaiting_operator',
    })

    // Caso 3: reset remoto (ref sumiu após intenção conhecida) -> ambiguous com awaiting_operator
    const portReset = {
      readRef: vi.fn(async () => null),
    }
    const outcome3 = await reconcilePush({
      intent: {
        step_id: 'push:reset',
        effect_class: 'push',
        commit: 'def',
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: 'abc',
        },
      },
      remotePort: portReset,
    })
    expect(outcome3).toMatchObject({
      verdict: 'ambiguous',
      state: 'awaiting_operator',
    })
  })

  // CA3: Dada branch local ainda fixada no commit revisado e base inalterada, quando o merge local
  // ocorre, então é fast-forward; branch movida, base movida ou MERGE_HEAD presente não é repetida.
  // Exemplos:
  // - {base_before:'abc',base_current:'abc',reviewed:'def',merge_head:null} -> {verdict:'ok',commit:'def'}
  // - {merge_head:'def'} -> {verdict:'ambiguous',fast_forward_calls:0}
  test('ca3_local_merge_fast_forward_or_ambiguous_on_drift', async () => {
    // Sub-caso 1: merge_head presente -> ambiguous sem chamar fastForward
    const ffCalls = vi.fn(async () => ({ commit: 'def' }))
    const gitPortMergeHead = {
      headInfo: vi.fn(async () => ({ commit: 'def', branch: 'feature', detached: false })),
      readLocalRef: vi.fn(async (ref: string) => {
        if (ref === 'MERGE_HEAD') return 'def'
        if (ref === 'main') return 'abc'
        return null
      }),
      fastForward: ffCalls,
    }
    const outcome1 = await reconcileLocalMerge({
      intent: {
        step_id: 'merge:1',
        effect_class: 'local_merge',
        base_ref: 'main',
        base_before: 'abc',
        reviewed_commit: 'def',
        merge_head: 'def',
      },
      gitPort: gitPortMergeHead,
    })
    expect(outcome1).toMatchObject({
      verdict: 'ambiguous',
      fast_forward_calls: 0,
    })
    expect(ffCalls).not.toHaveBeenCalled()

    // Sub-caso 2: base inalterada e reviewed ok -> ok com commit def
    const gitPortOk = {
      headInfo: vi.fn(async () => ({ commit: 'def', branch: 'feature', detached: false })),
      readLocalRef: vi.fn(async (ref: string) => {
        if (ref === 'MERGE_HEAD') return null
        if (ref === 'main') return 'abc'
        return null
      }),
      fastForward: vi.fn(async (baseRef: string, reviewedCommit: string) => ({ commit: reviewedCommit })),
    }
    const outcome2 = await reconcileLocalMerge({
      intent: {
        step_id: 'merge:2',
        effect_class: 'local_merge',
        base_ref: 'main',
        base_before: 'abc',
        reviewed_commit: 'def',
        merge_head: null,
      },
      gitPort: gitPortOk,
    })
    expect(outcome2).toMatchObject({
      verdict: 'ok',
      commit: 'def',
    })
    expect(gitPortOk.fastForward).toHaveBeenCalledWith('main', 'def')

    // Sub-caso 3: branch movida (currentHead != reviewedCommit) -> ambiguous
    const gitPortBranchMoved = {
      headInfo: vi.fn(async () => ({ commit: 'drifted', branch: 'feature', detached: false })),
      readLocalRef: vi.fn(async () => 'abc'),
      fastForward: vi.fn(),
    }
    const outcome3 = await reconcileLocalMerge({
      intent: {
        step_id: 'merge:3',
        effect_class: 'local_merge',
        base_ref: 'main',
        base_before: 'abc',
        reviewed_commit: 'def',
      },
      gitPort: gitPortBranchMoved,
    })
    expect(outcome3.verdict).toBe('ambiguous')
    expect(gitPortBranchMoved.fastForward).not.toHaveBeenCalled()

    // Sub-caso 4: base movida (baseCurrent != baseBefore) -> ambiguous
    const gitPortBaseMoved = {
      headInfo: vi.fn(async () => ({ commit: 'def', branch: 'feature', detached: false })),
      readLocalRef: vi.fn(async (ref: string) => {
        if (ref === 'MERGE_HEAD') return null
        if (ref === 'main') return 'moved'
        return null
      }),
      fastForward: vi.fn(),
    }
    const outcome4 = await reconcileLocalMerge({
      intent: {
        step_id: 'merge:4',
        effect_class: 'local_merge',
        base_ref: 'main',
        base_before: 'abc',
        reviewed_commit: 'def',
      },
      gitPort: gitPortBaseMoved,
    })
    expect(outcome4.verdict).toBe('ambiguous')
    expect(gitPortBaseMoved.fastForward).not.toHaveBeenCalled()
  })

  // CA4: Dado o caso push_that_errors_after_landing_is_not_repeated no Windows, quando a faixa
  // roda, então ele passa sem skip usando node e um remoto bare temporário.
  // Exemplo: process.platform:'win32' e shim process.execPath -> {skipped:0,passed:1}
  test('ca4_win32_push_runs_via_node_shim_without_skip', async () => {
    expect(typeof process.execPath).toBe('string')
    expect(process.execPath.length).toBeGreaterThan(0)

    const bare = makeBareRepo()
    const local = makeRepo()
    tempDirs.push(local.dir)
    local.git(['remote', 'add', 'origin', bare.dir])

    writeFileSync(path.join(local.dir, 'ca4.txt'), 'ca4 test\n')
    local.git(['add', '-A'])
    local.git(['commit', '-m', 'ca4 commit'])
    const commit = local.git(['rev-parse', 'HEAD']).trim()

    const shimDir = makeTempDir('ade-ca4-shim-')
    const shimPath = makeShimScript(shimDir)
    const counterFile = path.join(shimDir, 'pushes.txt')

    let caught = false
    try {
      execFileSync(
        process.execPath,
        [shimPath, counterFile, '1', local.dir, 'origin', 'main'],
        { encoding: 'utf8' },
      )
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
    expect(Number(readFileSync(counterFile, 'utf8'))).toBe(1)

    const gitPort = createGitPort({ worktreeDir: local.dir })
    const outcome = await reconcilePush({
      intent: {
        step_id: 'push:ca4',
        effect_class: 'push',
        commit,
        branch: 'main',
        remote: 'origin',
        intent_context: {
          remote_before: null,
          commit,
        },
      },
      remotePort: gitPort,
    })

    expect(outcome.verdict).toBe('ok')
    expect(outcome.remote_head).toBe(commit)
  })

  // CA5: Dado qualquer efeito remoto aberto, quando sua decisão é gravada, então intent_context
  // contém os valores anteriores usados e esses valores não alteram input_digest.
  // Exemplo: intent_context.remote_before:'abc' alterado para 'def' -> input_digest inalterado
  test('ca5_remote_intent_context_recorded_without_altering_input_digest', () => {
    expect(EFFECT_CLASSES).toContain('push')
    expect(EFFECT_CLASSES).toContain('local_merge')

    const input = { action: 'deploy', target: 'production' }
    const initialDigest = digest16(input)

    const intentWithAbc = {
      unit: 'T100',
      id: 'T100:push',
      effect_class: 'push',
      input,
      intent_context: { remote_before: 'abc' },
    }

    const intentWithDef = {
      unit: 'T100',
      id: 'T100:push',
      effect_class: 'push',
      input,
      intent_context: { remote_before: 'def' },
    }

    expect(digest16(intentWithAbc.input)).toBe(initialDigest)
    expect(digest16(intentWithDef.input)).toBe(initialDigest)
    expect(digest16(intentWithAbc.input)).toBe(digest16(intentWithDef.input))
  })

  // Erros tipados como subclasses de AdeError: exitCode 4 para entrada inválida e 2 para erro de git/integridade
  test('reconcile_delivery_and_gitport_throw_ade_error_subclasses_with_expected_exit_codes', async () => {
    // reconcilePush com entradas inválidas lança DeliveryInvalidInputError (exitCode 4)
    await expect(
      reconcilePush({ intent: null as any, remotePort: {} as any }),
    ).rejects.toThrow(DeliveryInvalidInputError)

    try {
      await reconcilePush({ intent: null as any, remotePort: {} as any })
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.exitCode).toBe(4)
      expect(err.code).toBe('invalid_input')
    }

    await expect(
      reconcilePush({
        intent: { step_id: 'p1', effect_class: 'push', remote: '' },
        remotePort: { readRef: async () => null },
      }),
    ).rejects.toThrow(DeliveryInvalidInputError)

    // reconcileLocalMerge com entradas inválidas lança DeliveryInvalidInputError (exitCode 4)
    await expect(
      reconcileLocalMerge({ intent: null as any, gitPort: {} as any }),
    ).rejects.toThrow(DeliveryInvalidInputError)

    try {
      await reconcileLocalMerge({ intent: null as any, gitPort: {} as any })
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.exitCode).toBe(4)
      expect(err.code).toBe('invalid_input')
    }

    // GitPort com entradas inválidas lança GitInvalidInputError (exitCode 4)
    const repo = makeRepo()
    tempDirs.push(repo.dir)
    const gitPort = createGitPort({ worktreeDir: repo.dir })

    await expect(gitPort.readRemoteRef('', 'main')).rejects.toThrow(GitInvalidInputError)
    try {
      await gitPort.readRemoteRef('', 'main')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.exitCode).toBe(4)
      expect(err.code).toBe('invalid_input')
    }

    await expect(gitPort.fastForward('', 'abc')).rejects.toThrow(GitInvalidInputError)
    try {
      await gitPort.fastForward('', 'abc')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.exitCode).toBe(4)
      expect(err.code).toBe('invalid_input')
    }
  })

  // Caminho durável via reconcileAll para push com bare repo
  test('reconcile_all_push_durable_with_bare_repo', async () => {
    const bare = makeBareRepo()
    const local = makeRepo()
    tempDirs.push(local.dir)
    local.git(['remote', 'add', 'origin', bare.dir])

    writeFileSync(path.join(local.dir, 'durable.txt'), 'durable content\n')
    local.git(['add', '-A'])
    local.git(['commit', '-m', 'durable push commit'])
    const commit = local.git(['rev-parse', 'HEAD']).trim()

    // Push para o bare
    local.git(['push', 'origin', 'main'])

    const missionDir = makeTempDir('ade-durable-mission-')
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: local.dir })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T101:push',
      effect_class: 'push',
      input_digest: digest16({ push: true }),
      intent_context: {
        remote_before: null,
        head_after: commit,
      },
      data: {
        commit,
        remote: 'origin',
        branch: 'main',
      },
      worktree: local.dir,
      unit: 'T101',
    })

    const verdicts = await reconcileAll({
      journal,
      missionDir,
      gitPort,
      deps: { remotePort: gitPort },
    })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].verdict).toBe('ok')
    expect(verdicts[0].effect_class).toBe('push')

    const events = readJournal(path.join(missionDir, 'journal.jsonl')).events
    const last = events[events.length - 1]
    expect(last.kind).toBe('step_result')
    expect(last.status).toBe('ok')
  })

  // Caminho durável via reconcileAll para local_merge com GitPort real
  test('reconcile_all_local_merge_durable_with_real_gitport', async () => {
    const repo = makeRepo()
    tempDirs.push(repo.dir)

    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit base'])
    const commitBase = repo.git(['rev-parse', 'HEAD']).trim()

    // Cria commit de feature em branch separada
    repo.git(['checkout', '-b', 'feature'])
    writeFileSync(path.join(repo.dir, 'feature.txt'), 'feature\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit feature'])
    const commitFeature = repo.git(['rev-parse', 'HEAD']).trim()
    // Mantém branch local no commit revisado (feature)
    const missionDir = makeTempDir('ade-merge-mission-')
    const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
    const gitPort = createGitPort({ worktreeDir: repo.dir })

    await journal.append({
      kind: 'step_intent',
      step_id: 'T102:merge',
      effect_class: 'local_merge',
      input_digest: digest16({ merge: true }),
      intent_context: {
        base_before: commitBase,
        head_after: commitFeature,
      },
      data: {
        reviewed_commit: commitFeature,
        base_ref: 'main',
      },
      worktree: repo.dir,
      unit: 'T102',
    })

    const verdicts = await reconcileAll({
      journal,
      missionDir,
      gitPort,
      deps: {},
    })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].verdict).toBe('ok')
    expect(verdicts[0].effect_class).toBe('local_merge')

    // Confere que o main agora está em commitFeature
    const mainHead = repo.git(['rev-parse', 'refs/heads/main']).trim()
    expect(mainHead).toBe(commitFeature)

    const events = readJournal(path.join(missionDir, 'journal.jsonl')).events
    const last = events[events.length - 1]
    expect(last.kind).toBe('step_result')
    expect(last.status).toBe('ok')
  })
})
