import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.ade')
export const WT_ROOT = path.join(ADE_DIR, 'wt')

const LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'packages.lock.json',
  'pubspec.lock',
  'mix.lock'
]

export const DIFF_EXCLUDES = [
  'node_modules',
  '**/node_modules/**',
  ...LOCKFILES.flatMap((file) => [file, `**/${file}`]),
  '.ade-vitest.json',
  'dist',
  'build',
  'target',
  'obj',
  '.gradle',
  '.dart_tool',
  '__pycache__',
  '.venv',
  '.ade-attachments'
].map((item) => `:(exclude)${item}`)

export const MESSAGES = Object.freeze({
  busy: 'Tem uma missão rodando nesta pasta. Espere ela terminar para aprovar.',
  dirty: 'A pasta tem alterações suas ainda não commitadas. Commite ou descarte antes de aprovar.',
  stale: 'O projeto mudou depois desta proposta. Peça a mudança de novo.',
  conflict: 'As mudanças não se encaixam mais nos arquivos do projeto. Peça de novo.',
  noHead: 'A pasta precisa ter pelo menos um commit antes de o chat propor mudanças.',
  badId: 'Identificador de conversa inválido.'
})

export const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.secrets?|id_(rsa|ed25519|ecdsa)|[^/]*\.(pem|p12|pfx|key))$/i

const ID_PATTERN = /^[a-z0-9-]{1,40}$/i
const locks = new Map()

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

function gitError(result) {
  const message = result.err.trim().split(/\r?\n/)[0] || 'Falha ao executar o git.'
  return codedError('git', message)
}

async function locked(key, operation) {
  const previous = locks.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  locks.set(key, current)
  try {
    return await current
  } finally {
    if (locks.get(key) === current) locks.delete(key)
  }
}

export function git(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
            out: stdout || '',
            err: stderr || ''
          })
        }
      )
    } catch (error) {
      resolve({ code: -1, out: '', err: error instanceof Error ? error.message : String(error) })
      return
    }

    child.stdin?.end(input)
  })
}

export async function createChatWorktree(projectDir, id, { wtRoot = WT_ROOT } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw codedError('bad-id', MESSAGES.badId)
  }

  const wtPath = path.join(path.resolve(wtRoot), `chat-${id}`)
  return locked(wtPath, async () => {
    const headResult = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir })
    if (headResult.code !== 0) throw codedError('no-head', MESSAGES.noHead)
    const head = headResult.out.trim()

    const pruneResult = await git(['worktree', 'prune'], { cwd: projectDir })
    if (pruneResult.code !== 0) throw gitError(pruneResult)

    await fs.mkdir(path.dirname(wtPath), { recursive: true })
    const removeResult = await git(['worktree', 'remove', '--force', wtPath], { cwd: projectDir })
    if (removeResult.code !== 0) await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3 })

    const addResult = await git(['worktree', 'add', '--detach', wtPath, 'HEAD'], { cwd: projectDir })
    if (addResult.code !== 0) throw gitError(addResult)
    return { path: wtPath, head }
  })
}

export async function removeChatWorktree(projectDir, wtPath) {
  const resolved = path.resolve(wtPath)
  await locked(resolved, async () => {
    await git(['worktree', 'remove', '--force', resolved], { cwd: projectDir })
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 })
    const pruneResult = await git(['worktree', 'prune'], { cwd: projectDir })
    if (pruneResult.code !== 0) throw gitError(pruneResult)
  })
}

export async function pruneChatWorktrees(adeDir = ADE_DIR, keep = []) {
  const wtDir = path.join(path.resolve(adeDir), 'wt')
  let entries
  try {
    entries = await fs.readdir(wtDir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }

  const preserved = new Set(keep.map((id) => `chat-${id}`))
  const candidates = entries
    .filter((entry) => entry.name.startsWith('chat-') && !preserved.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  const wtReal = await fs.realpath(wtDir)
  const paths = []
  for (const entry of candidates) {
    const candidate = path.join(wtDir, entry.name)
    const stats = await fs.lstat(candidate)
    if (!entry.isDirectory() || stats.isSymbolicLink()) {
      throw codedError('git', `Cópia de chat insegura: ${entry.name}`)
    }
    const real = await fs.realpath(candidate)
    if (path.dirname(real) !== wtReal) {
      throw codedError('git', `Cópia de chat fora da pasta esperada: ${entry.name}`)
    }
    paths.push(candidate)
  }

  for (const candidate of paths) {
    await fs.rm(candidate, { recursive: true, force: true, maxRetries: 3 })
  }
  return candidates.map((entry) => entry.name)
}
