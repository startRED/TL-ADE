import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as chatChanges from './chat-changes.mjs'

const createdWorktrees = []
const tempDirs = []

function gitCmd(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || ''
        })
      }
    )
  })
}

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-chat-routes-'))
  await gitCmd(['init', '-q'], repo)
  const excludes = path.join(repo, '.git', 'ade-empty-excludes')
  const hooks = path.join(repo, '.git', 'ade-empty-hooks')
  await fs.writeFile(excludes, '')
  await fs.mkdir(hooks, { recursive: true })
  await gitCmd(['config', 'core.excludesFile', excludes], repo)
  await gitCmd(['config', 'core.hooksPath', hooks], repo)
  await gitCmd(['config', 'commit.gpgSign', 'false'], repo)
  await fs.writeFile(path.join(repo, 'a.txt'), 'um\n')
  await gitCmd(['add', '.'], repo)
  await gitCmd(['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'inicial'], repo)
  tempDirs.push(repo)
  return repo
}

afterEach(async () => {
  for (const { repo, wtPath } of createdWorktrees) {
    await chatChanges.removeChatWorktree(repo, wtPath).catch(() => {})
  }
  createdWorktrees.length = 0
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  tempDirs.length = 0
})

describe('chatCommand', () => {
  it('CA1: Claude permite somente ferramentas de edição e repassa esforço válido', () => {
    const command = chatChanges.chatCommand('claude', {
      model: 'sonnet', effort: 'high', cwd: 'W', prompt: 'P'
    })

    assert.equal(command.cmd, 'claude')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, 'P')
    const tools = command.args.indexOf('--tools')
    assert.deepEqual(command.args.slice(tools, tools + 9), [
      '--tools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'WebFetch', 'WebSearch'
    ])
    assert.deepEqual(command.args.slice(-11), [
      '--tools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'WebFetch', 'WebSearch', '--effort', 'high'
    ])
    assert.ok(command.args.includes('--permission-mode'))
    assert.equal(command.args[command.args.indexOf('--permission-mode') + 1], 'acceptEdits')
    assert.ok(!command.args.includes('Bash'))
    assert.ok(!command.args.includes('plan'))
  })

  it('CA2: Codex escreve somente na cópia e recebe o prompt por stdin', () => {
    const command = chatChanges.chatCommand('codex', {
      model: 'gpt-5.6-sol', effort: 'high', cwd: 'W', prompt: 'P'
    })

    assert.equal(command.cmd, 'codex')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, 'P')
    assert.deepEqual(command.args.slice(command.args.indexOf('--sandbox'), command.args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write'])
    assert.deepEqual(command.args.slice(command.args.indexOf('-C'), command.args.indexOf('-C') + 2), ['-C', 'W'])
    assert.deepEqual(command.args.slice(command.args.indexOf('-m'), command.args.indexOf('-m') + 2), ['-m', 'gpt-5.6-sol'])
    assert.ok(command.args.includes('model_reasoning_effort=high'))
    assert.equal(command.args.at(-1), '-')
    assert.ok(!command.args.includes('read-only'))
  })

  it('CA3: agy coloca o pedido sanitizado em print sem modo de plano', () => {
    const command = chatChanges.chatCommand('agy', {
      model: 'gemini-3.8-flash-high', effort: 'high', cwd: 'W', prompt: 'diga "oi"\nagora'
    })

    assert.equal(command.cmd, 'agy')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, undefined)
    assert.equal(command.args[0], "--print=diga 'oi' agora")
    assert.deepEqual(command.args.slice(command.args.indexOf('--model'), command.args.indexOf('--model') + 2), ['--model', 'gemini-3.8-flash-high'])
    assert.ok(command.args.includes('--dangerously-skip-permissions'))
    assert.ok(!command.args.includes('--mode'))
    assert.ok(!command.args.includes('plan'))
  })

  it('CA4: esforço inválido é omitido no Claude e vira medium no Codex', () => {
    const claude = chatChanges.chatCommand('claude', {
      model: 'sonnet', effort: undefined, cwd: 'W', prompt: 'P'
    })
    const codex = chatChanges.chatCommand('codex', {
      model: 'm', effort: 'turbo', cwd: 'W', prompt: 'P'
    })

    assert.ok(!claude.args.includes('--effort'))
    assert.ok(codex.args.includes('model_reasoning_effort=medium'))
  })
})

describe('chatIntro', () => {
  it('CA1: abre o chat em modo escrita na cópia isolada, sem modo somente leitura', () => {
    const intro = chatChanges.chatIntro({
      name: 'demo', dir: 'C:/proj', wtPath: 'C:/copia'
    })

    assert.ok(intro.includes('pode criar, alterar e apagar arquivos'))
    assert.ok(intro.includes('aprova ou recusa num cartão'))
    assert.ok(intro.includes('não faça commit'))
    assert.ok(intro.includes('C:/copia'))
    assert.ok(!intro.includes('Só leitura'))
  })
})

describe('formatHistory', () => {
  it('CA2: anota no histórico a proposta recusada', () => {
    const history = chatChanges.formatHistory([
      { role: 'user', text: 'crie ola.txt' },
      {
        role: 'ai',
        text: 'Criei ola.txt.',
        proposal: { state: 'rejected', files: [{ path: 'ola.txt', kind: 'created' }] }
      }
    ])

    assert.equal(
      history,
      'Usuário: crie ola.txt\nAssistente: Criei ola.txt. [proposta recusada pelo usuário]'
    )
  })

  it('CA3: anota arquivos e tipos de uma proposta aplicada', () => {
    const history = chatChanges.formatHistory([
      {
        role: 'ai',
        text: 'Mudanças aplicadas.',
        proposal: {
          state: 'applied',
          files: [
            { path: 'ola.txt', kind: 'created' },
            { path: 'b.txt', kind: 'changed' },
            { path: 'c.txt', kind: 'deleted' }
          ]
        }
      }
    ])

    assert.ok(history.endsWith('[proposta aplicada: ola.txt criado, b.txt alterado, c.txt apagado]'))
  })

  it('CA4: retorna vazio sem turnos e mantém apenas os oito últimos sem notas', () => {
    assert.equal(chatChanges.formatHistory([]), '')

    const turns = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'ai',
      text: `m${index}`
    }))
    const history = chatChanges.formatHistory(turns)

    assert.equal(history.split('\n').length, 8)
    assert.equal(history.split('\n')[0], 'Usuário: m2')
    assert.ok(!history.includes('['))
  })
})

describe('propostas pendentes', () => {
  it('CA1: attachProposal transforma mudanças da cópia em proposta pendente sem alterar o repositório', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)
    const id = 'a1b2c3d4e5f6'
    const { path: wtPath, head } = await chatChanges.createChatWorktree(repo, id, { wtRoot })
    createdWorktrees.push({ repo, wtPath })
    await fs.writeFile(path.join(wtPath, 'ola.txt'), 'oi')

    const proposal = await chatChanges.attachProposal({
      projectDir: repo, id, wtPath, request: 'crie ola.txt', answer: 'Criei ola.txt com o texto oi.'
    })

    assert.deepEqual(proposal.files, [{ path: 'ola.txt', kind: 'created' }])
    assert.equal(proposal.state, 'pending')
    assert.equal(proposal.id, id)
    assert.equal(proposal.head, head)
    assert.equal(proposal.wt, wtPath)
    assert.equal(proposal.summary, 'Criei ola.txt com o texto oi.')
    await assert.rejects(fs.access(path.join(repo, 'ola.txt')), { code: 'ENOENT' })
  })

  it('CA2: attachProposal remove a cópia intacta e não cria proposta', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)
    const { path: wtPath } = await chatChanges.createChatWorktree(repo, 'b1b2c3d4e5f6', { wtRoot })

    const proposal = await chatChanges.attachProposal({
      projectDir: repo, id: 'b1b2c3d4e5f6', wtPath, request: 'x', answer: 'Sem mudanças.'
    })

    assert.equal(proposal, null)
    await assert.rejects(fs.access(wtPath), { code: 'ENOENT' })
  })

  it('CA3: proposalSummary usa a primeira linha útil, recua ao pedido e limita a 120 caracteres', () => {
    assert.equal(chatChanges.proposalSummary('## **Criei** ola.txt\n\nPronto.', 'x'), '**Criei** ola.txt')
    assert.equal(chatChanges.proposalSummary('', 'crie\nola.txt'), 'crie ola.txt')
    assert.equal(chatChanges.proposalSummary('x'.repeat(200), 'pedido').length, 120)
    assert.ok(chatChanges.proposalSummary('x'.repeat(200), 'pedido').endsWith('…'))
  })

  it('CA4: pendingProposal devolve a proposta pendente mais recente ou null sem pendências', () => {
    const proposal = chatChanges.pendingProposal([
      { role: 'ai', text: '', proposal: { id: 'a', state: 'rejected' } },
      { role: 'ai', text: '', proposal: { id: 'b', state: 'pending' } }
    ])

    assert.equal(proposal.id, 'b')
    assert.equal(chatChanges.pendingProposal([{ proposal: { state: 'applied' } }]), null)
    assert.equal(chatChanges.pendingProposal([]), null)
  })
})
