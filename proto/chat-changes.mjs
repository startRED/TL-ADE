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

export function canApprove({ busy, dirty, head, proposalHead }) {
  if (busy) return { ok: false, reason: MESSAGES.busy }
  if (dirty) return { ok: false, reason: MESSAGES.dirty }
  if (head !== proposalHead) return { ok: false, reason: MESSAGES.stale }
  return { ok: true, reason: null }
}

const CHAT_EFFORTS = ['low', 'medium', 'high']

export function chatCommand(family, { model, effort, cwd, prompt }) {
  if (family === 'codex') {
    const args = [
      'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check',
      '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c',
      `model_reasoning_effort=${CHAT_EFFORTS.includes(effort) ? effort : 'medium'}`,
      '-C', cwd, '-m', model, '-'
    ]
    return { cmd: 'codex', args, cwd, stdin: prompt }
  }

  if (family === 'agy') {
    const args = [
      `--print=${prompt.replace(/"/g, "'").replace(/\r?\n/g, ' ')}`,
      '--output-format', 'json', '--model', model, '--dangerously-skip-permissions'
    ]
    return { cmd: 'agy', args, cwd, stdin: undefined }
  }

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--no-session-persistence', '--max-turns', '20', '--model', model,
    '--permission-mode', 'acceptEdits', '--exclude-dynamic-system-prompt-sections', '--tools',
    'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'WebFetch', 'WebSearch'
  ]
  if (CHAT_EFFORTS.includes(effort)) args.push('--effort', effort)
  return { cmd: 'claude', args, cwd, stdin: prompt }
}

export function chatIntro({ name, dir, wtPath }) {
  return `Você é o assistente de conversa da TL-ADE no projeto ${name}. Responda em português, direto e curto (até ~250 palavras, salvo pedido de detalhe); listas curtas e blocos de código quando ajudarem. Você está numa cópia isolada do projeto, na pasta atual (${wtPath}); o original fica em ${dir} e você nunca escreve lá. Quando o pedido exigir, pode criar, alterar e apagar arquivos da pasta atual, usando caminhos relativos a ela. Nada disso vai direto para o projeto: suas mudanças viram uma proposta que a pessoa aprova ou recusa num cartão. Não rode comandos que alterem o projeto (instalar pacote, apagar pasta, git) e não faça commit. Se a pergunta for sobre o projeto, leia só o necessário. Ao terminar uma mudança, comece a resposta com uma linha curta dizendo o que mudou.`
}

const KIND_WORDS = {
  created: 'criado',
  changed: 'alterado',
  deleted: 'apagado'
}

function proposalNote(proposal) {
  if (proposal.state === 'rejected') return '[proposta recusada pelo usuário]'
  if (proposal.state === 'applied') {
    return `[proposta aplicada: ${proposal.files.map((file) => `${file.path} ${KIND_WORDS[file.kind] || 'alterado'}`).join(', ')}]`
  }
  return '[proposta aguardando decisão]'
}

export function formatHistory(turns = []) {
  return turns.slice(-8).map((turn) => `${turn.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(turn.text || '').slice(0, 1500)}${turn.proposal ? ` ${proposalNote(turn.proposal)}` : ''}`).join('\n')
}

export function proposalSummary(answer, request) {
  let text = ''
  for (const line of String(answer || '').split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^(?:#{1,6}|>|[-*_`])\s+/, '').trim()
    if (trimmed) {
      text = trimmed
      break
    }
  }
  if (!text) text = String(request || '').replace(/\s*\r?\n\s*/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

export async function attachProposal({ projectDir, id, wtPath, request, answer }) {
  const collected = await collectProposal(projectDir, wtPath)
  if (collected === null) {
    await removeChatWorktree(projectDir, wtPath)
    return null
  }
  return {
    id,
    head: collected.head,
    files: collected.files.map(({ path: filePath, kind }) => ({ path: filePath, kind })),
    patch: collected.patch,
    summary: proposalSummary(answer, request),
    state: 'pending',
    wt: wtPath
  }
}

export async function chatWriteTurn({ projectDir, id, request, exec, wtRoot = WT_ROOT, attachments = [] }) {
  const { path: wtPath } = await createChatWorktree(projectDir, id, { wtRoot })
  try {
    const answer = String((await exec(wtPath)) ?? '')
    const proposal = await attachProposal({ projectDir, id, wtPath, request, answer })
    return { answer, proposal }
  } catch (error) {
    await removeChatWorktree(projectDir, wtPath).catch(() => {})
    throw error
  }
}

export const PENDING_BLOCK = 'Decida o cartão anterior (Aprovar ou Recusar) antes de perguntar de novo.'

export function pendingProposal(turns = []) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const proposal = turns[index].proposal
    if (proposal?.state === 'pending') return proposal
  }
  return null
}

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
    const removeResult = await git(['worktree', 'remove', '--force', '--force', wtPath], { cwd: projectDir })
    if (removeResult.code !== 0) {
      await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3 })
      const retryPruneResult = await git(['worktree', 'prune'], { cwd: projectDir })
      if (retryPruneResult.code !== 0) throw gitError(retryPruneResult)
    }

    const addResult = await git(['worktree', 'add', '--detach', wtPath, 'HEAD'], { cwd: projectDir })
    if (addResult.code !== 0) throw gitError(addResult)
    return { path: wtPath, head }
  })
}

export async function removeChatWorktree(projectDir, wtPath) {
  const resolved = path.resolve(wtPath)
  await locked(resolved, async () => {
    await git(['worktree', 'remove', '--force', '--force', resolved], { cwd: projectDir })
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
  const removed = []
  for (const entry of candidates) {
    const candidate = path.join(wtDir, entry.name)
    try {
      const stats = await fs.lstat(candidate)
      if (!entry.isDirectory() || stats.isSymbolicLink()) continue
      const real = await fs.realpath(candidate)
      if (path.dirname(real) !== wtReal) continue
      await fs.rm(candidate, { recursive: true, force: true, maxRetries: 3 })
      removed.push(entry.name)
    } catch {
      continue
    }
  }
  return removed
}

function parseStatus(out) {
  const statuses = new Map()
  for (const record of out.split('\0')) {
    if (!record) continue
    const xy = record.slice(0, 2)
    const filePath = record.slice(3)
    const kind = xy === '??' || xy.includes('A')
      ? 'created'
      : xy.includes('D')
        ? 'deleted'
        : 'changed'
    statuses.set(filePath, kind)
  }
  return statuses
}

function proposalGitError(result) {
  const detail = result.err.trim().split(/\r?\n/)[0] || 'Falha ao executar o git.'
  return codedError('git', `git falhou: ${detail}`)
}

export async function collectProposal(projectDir, wtPath) {
  if (typeof projectDir !== 'string' || !projectDir || typeof wtPath !== 'string' || !wtPath) {
    throw codedError('git', 'git falhou: Caminho do projeto ou da cópia inválido.')
  }

  const statusResult = await git([
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.', ...DIFF_EXCLUDES
  ], { cwd: wtPath })
  if (statusResult.code !== 0) throw proposalGitError(statusResult)
  const kinds = parseStatus(statusResult.out)

  const addResult = await git(['add', '-N', '--', '.'], { cwd: wtPath })
  if (addResult.code !== 0) throw proposalGitError(addResult)

  const patchResult = await git([
    'diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', 'HEAD', '--', '.', ...DIFF_EXCLUDES
  ], { cwd: wtPath })
  if (patchResult.code !== 0) throw proposalGitError(patchResult)
  if (!patchResult.out.trim()) return null

  const namesResult = await git([
    'diff', '--name-only', '-z', '--no-renames', 'HEAD', '--', '.', ...DIFF_EXCLUDES
  ], { cwd: wtPath })
  if (namesResult.code !== 0) throw proposalGitError(namesResult)

  const files = []
  for (const filePath of namesResult.out.split('\0')) {
    if (!filePath) continue
    const diffResult = await git([
      'diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', 'HEAD', '--', `:(literal)${filePath}`
    ], { cwd: wtPath })
    if (diffResult.code !== 0) throw proposalGitError(diffResult)
    files.push({ path: filePath, kind: kinds.get(filePath) ?? 'changed', diff: diffResult.out })
  }

  const headResult = await git(['rev-parse', 'HEAD'], { cwd: wtPath })
  if (headResult.code !== 0) throw proposalGitError(headResult)
  return { head: headResult.out.trim(), patch: patchResult.out, files }
}

function commitMessage(summary) {
  let text = String(summary ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
  if (!text) text = 'alterações aprovadas'
  if (text.length > 72) text = `${text.slice(0, 71)}…`
  return `chat: ${text}`
}

export async function applyProposal(projectDir, proposal, summary) {
  if (
    typeof projectDir !== 'string' || !projectDir ||
    !proposal || typeof proposal.head !== 'string' || typeof proposal.patch !== 'string'
  ) {
    throw codedError('git', 'Proposta ou caminho do projeto inválido.')
  }

  return locked(path.resolve(projectDir), async () => {
    const headResult = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir })
    if (headResult.code !== 0 || headResult.out.trim() !== proposal.head) {
      throw codedError('stale', MESSAGES.stale)
    }

    const statusResult = await git(['status', '--porcelain', '--', '.'], { cwd: projectDir })
    if (statusResult.code !== 0) throw gitError(statusResult)
    if (statusResult.out) throw codedError('dirty', MESSAGES.dirty)

    const checkResult = await git(['apply', '--check', '-'], { cwd: projectDir, input: proposal.patch })
    if (checkResult.code !== 0) throw codedError('conflict', MESSAGES.conflict)

    const applyResult = await git(['apply', '-'], { cwd: projectDir, input: proposal.patch })
    if (applyResult.code !== 0) throw codedError('conflict', MESSAGES.conflict)

    const addResult = await git(['add', '-A', '--', '.'], { cwd: projectDir })
    if (addResult.code !== 0) throw gitError(addResult)

    const namesResult = await git(['diff', '--cached', '--name-only', '-z'], { cwd: projectDir })
    if (namesResult.code !== 0) throw gitError(namesResult)
    const skipped = namesResult.out.split('\0').filter((filePath) => SECRET_FILE.test(filePath))
    if (skipped.length) {
      const resetResult = await git(['reset', '-q', '--', ...skipped], { cwd: projectDir })
      if (resetResult.code !== 0) throw gitError(resetResult)
    }

    const commitResult = await git([
      '-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local',
      'commit', '-q', '-m', commitMessage(summary)
    ], { cwd: projectDir })
    if (commitResult.code !== 0) throw gitError(commitResult)

    const committedHead = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir })
    if (committedHead.code !== 0) throw gitError(committedHead)
    return { commit: committedHead.out.trim(), skipped }
  })
}

function findDecidable(turns, id) {
  const p = (turns || []).find((turn) => turn.proposal && turn.proposal.id === id)?.proposal
  if (!p) return { status: 404, body: { error: 'Proposta não encontrada.' } }
  if (p.state !== 'pending') return { status: 409, body: { error: 'Esta proposta já foi decidida.' } }
  return { p }
}

export async function approveChat({ projectDir, turns, id, busy }) {
  const decidable = findDecidable(turns, id)
  if (!decidable.p) return decidable
  const p = decidable.p
  const dirty = (await git(['status', '--porcelain', '--', '.'], { cwd: projectDir })).out.trim().length > 0
  const headResult = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir })
  const head = headResult.code === 0 ? headResult.out.trim() : null
  const approval = canApprove({ busy: !!busy, dirty, head, proposalHead: p.head })
  if (!approval.ok) return { status: 409, body: { error: approval.reason } }

  let result
  try {
    result = await applyProposal(projectDir, p, p.summary)
  } catch (error) {
    if (error?.code === 'git' && head) {
      await git(['reset', '-q', '--hard', head], { cwd: projectDir })
      for (const file of p.files || []) {
        if (file.kind === 'created') {
          await fs.rm(path.join(projectDir, file.path), { force: true }).catch(() => {})
        }
      }
    }
    return { status: 409, body: { error: error.message } }
  }

  await removeChatWorktree(projectDir, p.wt).catch(() => {})
  p.state = 'applied'
  p.commit = result.commit
  p.skipped = result.skipped
  p.decided_ts = new Date().toISOString()
  return { status: 200, body: { ok: true, commit: result.commit } }
}

export async function rejectChat({ projectDir, turns, id }) {
  const decidable = findDecidable(turns, id)
  if (!decidable.p) return decidable
  const p = decidable.p
  await removeChatWorktree(projectDir, p.wt).catch(() => {})
  p.state = 'rejected'
  p.decided_ts = new Date().toISOString()
  return { status: 200, body: { ok: true } }
}
