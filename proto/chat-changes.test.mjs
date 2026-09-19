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
  WT_ROOT,
  ADE_DIR
} from './chat-changes.mjs'

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
