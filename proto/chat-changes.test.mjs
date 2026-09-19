import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  createChatWorktree,
  removeChatWorktree,
  pruneChatWorktrees,
  collectProposal,
  WT_ROOT,
  ADE_DIR,
  MESSAGES
} from './chat-changes.mjs'
import * as chatChanges from './chat-changes.mjs'

const applyProposal = (...args) => {
  if (typeof chatChanges.applyProposal !== 'function') {
    throw new Error('não implementado')
  }
  return chatChanges.applyProposal(...args)
}

const canApprove = (...args) => {
  if (typeof chatChanges.canApprove !== 'function') {
    throw new Error('não implementado')
  }
  return chatChanges.canApprove(...args)
}

const PROTO_DIR = path.dirname(fileURLToPath(import.meta.url))
const TL_ADE_ROOT = path.resolve(PROTO_DIR, '..')

const createdWorktrees = []
const tempDirs = []

function gitCmd(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: stdout || '',
            stderr: stderr || ''
          })
        } else {
          resolve({ code: 0, stdout: stdout || '', stderr: stderr || '' })
        }
      }
    )
  })
}

export function newId() {
  return `t${process.pid}-${Date.now().toString(36)}`
}

export async function makeRepo() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-chat-'))
  await gitCmd(['init', '-q'], repoDir)

  const emptyExcludes = path.join(repoDir, '.git', 'ade-empty-excludes')
  await fs.writeFile(emptyExcludes, '')

  const emptyHooks = path.join(repoDir, '.git', 'ade-empty-hooks')
  await fs.mkdir(emptyHooks, { recursive: true })

  await gitCmd(['config', 'core.excludesFile', emptyExcludes], repoDir)
  await gitCmd(['config', 'core.hooksPath', emptyHooks], repoDir)
  await gitCmd(['config', 'commit.gpgSign', 'false'], repoDir)
  await gitCmd(['config', 'core.autocrlf', 'false'], repoDir)

  await fs.writeFile(path.join(repoDir, 'a.txt'), 'um\n')
  await fs.writeFile(path.join(repoDir, 'b.txt'), 'dois\n')
  await gitCmd(['add', '.'], repoDir)
  await gitCmd(
    ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'commit inicial'],
    repoDir
  )

  tempDirs.push(repoDir)
  return repoDir
}

afterEach(async () => {
  for (const { repo, path: wtPath } of createdWorktrees) {
    try {
      await removeChatWorktree(repo, wtPath)
    } catch {
      await gitCmd(['worktree', 'remove', '--force', wtPath], repo).catch(() => {})
      await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      await gitCmd(['worktree', 'prune'], repo).catch(() => {})
    }
  }
  createdWorktrees.length = 0

  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  tempDirs.length = 0
})

describe('chat-changes: cópia isolada (worktree)', () => {
  it('CA1: createChatWorktree cria worktree isolada sob WT_ROOT, ignorada pelo git e com mesmo HEAD', async () => {
    const repo = await makeRepo()
    const id = newId()
    const result = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: result.path })

    const expectedPath = path.join(WT_ROOT, `chat-${id}`)
    assert.equal(result.path, expectedPath)

    const headRes = await gitCmd(['rev-parse', 'HEAD'], repo)
    assert.equal(result.head, headRes.stdout.trim())
    assert.match(result.head, /^[0-9a-f]{40}$/i)

    const aContent = await fs.readFile(path.join(result.path, 'a.txt'), 'utf8')
    assert.equal(aContent, 'um\n')

    const checkIgnore = await gitCmd(['check-ignore', '-q', result.path], TL_ADE_ROOT)
    assert.equal(checkIgnore.code, 0)

    const statusRes = await gitCmd(['status', '--porcelain'], repo)
    assert.equal(statusRes.stdout.trim(), '')
  })

  it('CA1 (borda): createChatWorktree rejeita identificador inválido ou repositório sem HEAD', async () => {
    const repo = await makeRepo()

    await assert.rejects(
      async () => {
        await createChatWorktree(repo, '../fora')
      },
      (err) => {
        assert.equal(err.code, 'bad-id')
        assert.equal(err.message, 'Identificador de conversa inválido.')
        return true
      }
    )

    const emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-chat-empty-'))
    tempDirs.push(emptyRepo)
    await gitCmd(['init', '-q'], emptyRepo)

    await assert.rejects(
      async () => {
        await createChatWorktree(emptyRepo, newId())
      },
      (err) => {
        assert.equal(err.code, 'no-head')
        assert.equal(err.message, 'A pasta precisa ter pelo menos um commit antes de o chat propor mudanças.')
        return true
      }
    )
  })

  it('CA2: alterações na cópia não afetam o repositório principal', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')

    const statusRes = await gitCmd(['status', '--porcelain'], repo)
    assert.equal(statusRes.stdout.trim(), '')

    let existsInRepo = true
    try {
      await fs.access(path.join(repo, 'novo.txt'))
    } catch {
      existsInRepo = false
    }
    assert.equal(existsInRepo, false)
  })

  it('CA3: removeChatWorktree remove a cópia de forma idempotente e poda a lista de worktrees', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)

    await removeChatWorktree(repo, wtPath)
    await assert.doesNotReject(async () => {
      await removeChatWorktree(repo, wtPath)
    })

    let exists = true
    try {
      await fs.access(wtPath)
    } catch {
      exists = false
    }
    assert.equal(exists, false)

    const wtListRes = await gitCmd(['worktree', 'list', '--porcelain'], repo)
    const wtLines = wtListRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('worktree '))
    assert.equal(wtLines.length, 1)
  })

  it('CA4: pruneChatWorktrees remove apenas cópias de chat não preservadas e trata pasta inexistente', async () => {
    const adeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-chat-prune-'))
    tempDirs.push(adeDir)
    const wtDir = path.join(adeDir, 'wt')
    await fs.mkdir(path.join(wtDir, 'chat-x'), { recursive: true })
    await fs.mkdir(path.join(wtDir, 'chat-y'), { recursive: true })
    await fs.mkdir(path.join(wtDir, 'outra'), { recursive: true })

    const removed = await pruneChatWorktrees(adeDir, ['y'])
    assert.deepEqual(removed, ['chat-x'])

    let chatXExists = true
    try {
      await fs.access(path.join(wtDir, 'chat-x'))
    } catch {
      chatXExists = false
    }
    assert.equal(chatXExists, false)

    await assert.doesNotReject(async () => {
      await fs.access(path.join(wtDir, 'chat-y'))
      await fs.access(path.join(wtDir, 'outra'))
    })

    const nonExistent = path.join(adeDir, 'inexistente', 'diretorio')
    const emptyResult = await pruneChatWorktrees(nonExistent)
    assert.deepEqual(emptyResult, [])
  })
})

describe('pendências do e1: sobras estranhas', () => {
  it('CA1: pruneChatWorktrees remove somente a pasta chat segura', async () => {
    const adeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-'))
    const fora = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-fora-'))
    tempDirs.push(adeDir, fora)
    const wtDir = path.join(adeDir, 'wt')
    const chatOk = path.join(wtDir, 'chat-ok')
    await fs.mkdir(chatOk, { recursive: true })
    await fs.writeFile(path.join(chatOk, 'arquivo.txt'), 'apagar')
    await fs.writeFile(path.join(wtDir, 'chat-arquivo'), 'não apagar')
    await fs.writeFile(path.join(fora, 'fora.txt'), 'intacto')
    await fs.symlink(fora, path.join(wtDir, 'chat-link'), process.platform === 'win32' ? 'junction' : 'dir')

    const removed = await pruneChatWorktrees(adeDir)

    assert.deepEqual(removed, ['chat-ok'])
    await assert.rejects(fs.access(chatOk), { code: 'ENOENT' })
  })

  it('CA2: pruneChatWorktrees preserva arquivo e link de chat que apontam para fora', async () => {
    const adeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-'))
    const fora = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-fora-'))
    tempDirs.push(adeDir, fora)
    const wtDir = path.join(adeDir, 'wt')
    await fs.mkdir(path.join(wtDir, 'chat-ok'), { recursive: true })
    await fs.writeFile(path.join(wtDir, 'chat-arquivo'), 'não apagar')
    await fs.writeFile(path.join(fora, 'fora.txt'), 'intacto')
    const link = path.join(wtDir, 'chat-link')
    await fs.symlink(fora, link, process.platform === 'win32' ? 'junction' : 'dir')

    await pruneChatWorktrees(adeDir)

    await assert.doesNotReject(fs.lstat(path.join(wtDir, 'chat-arquivo')))
    await assert.doesNotReject(fs.lstat(link))
    assert.equal(await fs.readFile(path.join(fora, 'fora.txt'), 'utf8'), 'intacto')
    assert.deepEqual(await pruneChatWorktrees(path.join(adeDir, 'sem-wt')), [])
  })

  it('CA3: createChatWorktree substitui cópia travada sem registro locked duplicado', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-wt-'))
    tempDirs.push(wtRoot)
    const id = newId()
    const first = await createChatWorktree(repo, id, { wtRoot })
    const lockResult = await gitCmd(['worktree', 'lock', first.path], repo)
    assert.equal(lockResult.code, 0)

    const result = await createChatWorktree(repo, id, { wtRoot })
    createdWorktrees.push({ repo, path: result.path })

    assert.equal(result.path, first.path)
    const headResult = await gitCmd(['rev-parse', 'HEAD'], repo)
    assert.equal(result.head, headResult.stdout.trim())
    const listResult = await gitCmd(['worktree', 'list', '--porcelain'], repo)
    const listedPaths = listResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    const expected = await fs.realpath(path.resolve(result.path))
    const comparableExpected = process.platform === 'win32' ? expected.toLowerCase() : expected
    const matches = await Promise.all(listedPaths.map(async (listed) => {
      const real = await fs.realpath(path.resolve(listed))
      return (process.platform === 'win32' ? real.toLowerCase() : real) === comparableExpected
    }))
    assert.equal(matches.filter(Boolean).length, 1)
    assert.doesNotMatch(listResult.stdout, /^locked$/m)
  })

  it('CA4: removeChatWorktree remove cópia travada e seu registro', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-prune-wt-'))
    tempDirs.push(wtRoot)
    const { path: wtPath } = await createChatWorktree(repo, newId(), { wtRoot })
    const lockResult = await gitCmd(['worktree', 'lock', wtPath], repo)
    assert.equal(lockResult.code, 0)

    await removeChatWorktree(repo, wtPath)

    await assert.rejects(fs.access(wtPath), { code: 'ENOENT' })
    const listResult = await gitCmd(['worktree', 'list', '--porcelain'], repo)
    const removed = path.resolve(wtPath)
    const comparableRemoved = process.platform === 'win32' ? removed.toLowerCase() : removed
    const listedPaths = listResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length)))
      .map((listed) => process.platform === 'win32' ? listed.toLowerCase() : listed)
    assert.equal(listedPaths.includes(comparableRemoved), false)
  })
})

describe('collectProposal', () => {
  it('CA1: retorna lista ordenada com kind, diff de cada arquivo e head do commit base', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath, head } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'a.txt'), 'um\nmais\n')
    await fs.rm(path.join(wtPath, 'b.txt'))
    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')

    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)
    assert.equal(proposal.head, head)
    assert.ok(typeof proposal.patch === 'string' && proposal.patch.length > 0)
    assert.deepEqual(
      proposal.files.map((f) => [f.path, f.kind]),
      [
        ['a.txt', 'changed'],
        ['b.txt', 'deleted'],
        ['novo.txt', 'created']
      ]
    )
    assert.ok(proposal.files[0].diff.length > 0)
    assert.ok(proposal.files[1].diff.length > 0)
    assert.match(proposal.files[2].diff, /\+oi/)
  })

  it('CA2: devolve null quando a cópia não tem nenhuma alteração', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    const proposal = await collectProposal(repo, wtPath)
    assert.equal(proposal, null)
  })

  it('CA3: devolve null quando as alterações estão apenas em pastas excluídas como node_modules', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.mkdir(path.join(wtPath, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(wtPath, 'node_modules', 'x.js'), 'x')

    const proposal = await collectProposal(repo, wtPath)
    assert.equal(proposal, null)
  })

  it('CA4: suporta arquivos criados com espaço no nome e não altera o status do repositório', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'nome com espaço.txt'), 'oi\n')

    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)
    const file = proposal.files.find((f) => f.path === 'nome com espaço.txt')
    assert.ok(file)
    assert.equal(file.kind, 'created')
    assert.match(file.diff, /\+oi/)

    const statusRes = await gitCmd(['status', '--porcelain'], repo)
    assert.equal(statusRes.stdout.trim(), '')
  })
})

describe('applyProposal', () => {
  it('CA1: aplica proposta com a.txt alterado, b.txt apagado e novo.txt criado, com commit chat: <resumo>', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'a.txt'), 'um alterado\n')
    await fs.rm(path.join(wtPath, 'b.txt'))
    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')

    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)

    const result = await applyProposal(repo, proposal, 'ajusta textos')

    const logRes = await gitCmd(['log', '-1', '--format=%s'], repo)
    assert.equal(logRes.stdout.trim(), 'chat: ajusta textos')

    const headRes = await gitCmd(['rev-parse', 'HEAD'], repo)
    assert.equal(result.commit, headRes.stdout.trim())

    const aContent = await fs.readFile(path.join(repo, 'a.txt'), 'utf8')
    assert.equal(aContent, 'um alterado\n')

    let bExists = true
    try {
      await fs.access(path.join(repo, 'b.txt'))
    } catch {
      bExists = false
    }
    assert.equal(bExists, false)

    const novoContent = await fs.readFile(path.join(repo, 'novo.txt'), 'utf8')
    assert.equal(novoContent, 'oi\n')

    const statusRes = await gitCmd(['status', '--porcelain'], repo)
    assert.equal(statusRes.stdout.trim(), '')
  })

  it('CA1 (resumo): formata resumo longo com reticências e resumo vazio com padrão', async () => {
    const repo = await makeRepo()
    const id1 = newId()
    const { path: wt1 } = await createChatWorktree(repo, id1)
    createdWorktrees.push({ repo, path: wt1 })

    await fs.writeFile(path.join(wt1, 'c1.txt'), '1\n')
    const p1 = await collectProposal(repo, wt1)
    assert.ok(p1)

    const longSummary = 'a'.repeat(80)
    await applyProposal(repo, p1, longSummary)
    const log1 = await gitCmd(['log', '-1', '--format=%s'], repo)
    assert.equal(log1.stdout.trim(), 'chat: ' + 'a'.repeat(71) + '…')

    const id2 = newId()
    const { path: wt2 } = await createChatWorktree(repo, id2)
    createdWorktrees.push({ repo, path: wt2 })

    await fs.writeFile(path.join(wt2, 'c2.txt'), '2\n')
    const p2 = await collectProposal(repo, wt2)
    assert.ok(p2)

    await applyProposal(repo, p2, '')
    const log2 = await gitCmd(['log', '-1', '--format=%s'], repo)
    assert.equal(log2.stdout.trim(), 'chat: alterações aprovadas')
  })

  it('CA2: rejeita com code stale quando o HEAD do projeto mudou após a proposta', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')
    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)

    await fs.writeFile(path.join(repo, 'outro.txt'), 'outro\n')
    await gitCmd(['add', '.'], repo)
    await gitCmd(
      ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'commit extra'],
      repo
    )

    const headBefore = (await gitCmd(['rev-parse', 'HEAD'], repo)).stdout.trim()

    await assert.rejects(
      async () => {
        await applyProposal(repo, proposal, 'ajusta')
      },
      (err) => {
        assert.equal(err.code, 'stale')
        assert.equal(err.message, MESSAGES.stale)
        return true
      }
    )

    const headAfter = (await gitCmd(['rev-parse', 'HEAD'], repo)).stdout.trim()
    assert.equal(headAfter, headBefore)

    let novoExists = true
    try {
      await fs.access(path.join(repo, 'novo.txt'))
    } catch {
      novoExists = false
    }
    assert.equal(novoExists, false)
  })

  it('CA3: rejeita com code dirty quando a pasta tem alterações não commitadas', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')
    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)

    const countBefore = (await gitCmd(['rev-list', '--count', 'HEAD'], repo)).stdout.trim()

    await fs.writeFile(path.join(repo, 'solto.txt'), 'pendente\n')

    await assert.rejects(
      async () => {
        await applyProposal(repo, proposal, 'ajusta')
      },
      (err) => {
        assert.equal(err.code, 'dirty')
        assert.equal(err.message, MESSAGES.dirty)
        return true
      }
    )

    const countAfter = (await gitCmd(['rev-list', '--count', 'HEAD'], repo)).stdout.trim()
    assert.equal(countAfter, countBefore)
  })

  it('CA4: exclui arquivos de segredo do commit e devolve em skipped', async () => {
    const repo = await makeRepo()
    const id = newId()
    const { path: wtPath } = await createChatWorktree(repo, id)
    createdWorktrees.push({ repo, path: wtPath })

    await fs.writeFile(path.join(wtPath, '.env'), 'SENHA=1\n')
    await fs.writeFile(path.join(wtPath, 'novo.txt'), 'oi\n')
    const proposal = await collectProposal(repo, wtPath)
    assert.ok(proposal)

    const result = await applyProposal(repo, proposal, 'adiciona env e novo')

    assert.deepEqual(result.skipped, ['.env'])

    const showRes = await gitCmd(['show', '--name-only', '--format=', 'HEAD'], repo)
    const files = showRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    assert.ok(files.includes('novo.txt'))
    assert.ok(!files.includes('.env'))
  })
})

describe('canApprove', () => {
  it('CA1: busy verdadeiro recusa com motivo de missão rodando mesmo com dirty e heads divergentes', () => {
    assert.deepEqual(
      canApprove({ busy: true, dirty: true, head: 'b', proposalHead: 'a' }),
      { ok: false, reason: 'Tem uma missão rodando nesta pasta. Espere ela terminar para aprovar.' }
    )
  })

  it('CA2: busy falso e dirty verdadeiro recusa com motivo de alterações não commitadas', () => {
    assert.deepEqual(
      canApprove({ busy: false, dirty: true, head: 'a', proposalHead: 'a' }),
      { ok: false, reason: 'A pasta tem alterações suas ainda não commitadas. Commite ou descarte antes de aprovar.' }
    )
  })

  it('CA3: head divergente ou nulo recusa com motivo de projeto modificado após proposta', () => {
    assert.deepEqual(
      canApprove({ busy: false, dirty: false, head: 'bbb', proposalHead: 'aaa' }),
      { ok: false, reason: 'O projeto mudou depois desta proposta. Peça a mudança de novo.' }
    )
    assert.deepEqual(
      canApprove({ busy: false, dirty: false, head: null, proposalHead: 'aaa' }),
      { ok: false, reason: 'O projeto mudou depois desta proposta. Peça a mudança de novo.' }
    )
  })

  it('CA4: sem impedimentos e com mesmo head aprova com sucesso e motivo nulo', () => {
    assert.deepEqual(
      canApprove({ busy: false, dirty: false, head: 'aaa', proposalHead: 'aaa' }),
      { ok: true, reason: null }
    )
  })
})

