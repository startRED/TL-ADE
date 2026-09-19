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

async function makePendingProposal(repo, id) {
  const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
  tempDirs.push(wtRoot)
  const { path: wtPath } = await chatChanges.createChatWorktree(repo, id, { wtRoot })
  createdWorktrees.push({ repo, wtPath })
  await fs.writeFile(path.join(wtPath, 'ola.txt'), 'oi')
  const proposal = await chatChanges.attachProposal({
    projectDir: repo,
    id,
    wtPath,
    request: 'crie ola.txt',
    answer: 'Criei ola.txt com o texto oi.'
  })
  return {
    proposal,
    turns: [
      { role: 'user', text: 'crie ola.txt' },
      { role: 'ai', text: 'Criei ola.txt com o texto oi.', proposal }
    ]
  }
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

describe('discardPending e pendingChatIds', () => {
  it('CA1: rejeita propostas pendentes e descarta suas cópias', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'd1')

    const discarded = await chatChanges.discardPending({ projectDir: repo, turns })

    assert.equal(discarded, 1)
    assert.equal(proposal.state, 'rejected')
    await assert.rejects(fs.access(proposal.wt), { code: 'ENOENT' })
  })

  it('CA2: mantém propostas já aplicadas', async () => {
    const turns = [
      { role: 'user', text: 'oi' },
      { role: 'ai', text: 'ok', proposal: { id: 'x', state: 'applied', files: [] } }
    ]

    const discarded = await chatChanges.discardPending({ projectDir: 'irrelevante', turns })

    assert.equal(discarded, 0)
    assert.equal(turns[1].proposal.state, 'applied')
  })

  it('CA3: lista somente ids pendentes dos arquivos de conversa válidos', async () => {
    const chatsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-chats-'))
    tempDirs.push(chatsDir)
    await fs.writeFile(path.join(chatsDir, 'a.json'), JSON.stringify([
      { role: 'ai', proposal: { id: 'p1', state: 'pending' } },
      { role: 'ai', proposal: { id: 'r1', state: 'rejected' } }
    ]))
    await fs.writeFile(path.join(chatsDir, 'b.json'), 'não é json')

    assert.deepEqual(await chatChanges.pendingChatIds(chatsDir), ['p1'])
  })

  it('CA4: devolve lista vazia quando a pasta de conversas não existe', async () => {
    assert.deepEqual(
      await chatChanges.pendingChatIds(path.join(os.tmpdir(), 'nao-existe-ade-xyz')),
      []
    )
  })
})

describe('handleChatDecision e roteiro', () => {
  it('CA1 aprova, atualiza a pasta, salva e notifica nesta ordem', async () => {
    const { handleChatDecision } = await import('./chat-changes.mjs')
    const calls = []
    const turns = []
    const result = { status: 200, body: { ok: true, commit: 'abc' } }
    let approveArgs
    const approve = async (args) => {
      calls.push('approve')
      approveArgs = args
      return result
    }

    const actual = await handleChatDecision({
      action: 'approve', projectDir: 'P', turns, id: 'x1', busy: false,
      approve,
      refresh: async () => { calls.push('refresh') },
      save: async () => { calls.push('save') },
      notify: () => { calls.push('notify') }
    })

    assert.equal(actual, result)
    assert.deepEqual(approveArgs, { projectDir: 'P', turns, id: 'x1', busy: false })
    assert.deepEqual(calls, ['approve', 'refresh', 'save', 'notify'])
  })

  it('CA2 não produz efeitos após aprovação bloqueada', async () => {
    const { handleChatDecision, MESSAGES } = await import('./chat-changes.mjs')
    const calls = []
    const result = { status: 409, body: { error: MESSAGES.busy } }

    const actual = await handleChatDecision({
      action: 'approve', projectDir: 'P', turns: [], id: 'x1', busy: true,
      approve: async () => { calls.push('approve'); return result },
      refresh: async () => { calls.push('refresh') },
      save: async () => { calls.push('save') },
      notify: () => { calls.push('notify') }
    })

    assert.equal(actual, result)
    assert.deepEqual(calls, ['approve'])
  })

  it('CA3 recusa, salva e notifica sem atualizar a pasta', async () => {
    const { handleChatDecision } = await import('./chat-changes.mjs')
    const calls = []
    const result = { status: 200, body: { ok: true } }

    const actual = await handleChatDecision({
      action: 'reject', projectDir: 'P', turns: [], id: 'x1', busy: false,
      reject: async () => { calls.push('reject'); return result },
      refresh: async () => { calls.push('refresh') },
      save: async () => { calls.push('save') },
      notify: () => { calls.push('notify') }
    })

    assert.equal(actual, result)
    assert.deepEqual(calls, ['reject', 'save', 'notify'])
  })

  it('CA4 documenta o roteiro manual de aprovar e recusar propostas', async () => {
    const { readFile } = await import('node:fs/promises')
    const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8')
    const section = readme.slice(readme.indexOf('## Chat que altera arquivos (roteiro manual)'))

    assert.match(section, /crie o arquivo ola\.txt com o texto oi/)
    assert.match(section, /crie o arquivo tchau\.txt com o texto até logo/)
    assert.match(section, /\/api\/chat\/approve/)
    assert.match(section, /\/api\/chat\/reject/)
    assert.match(section, /git status/)
  })
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

describe('server.mjs: chat em modo escrita', () => {
  const serverUrl = new URL('./server.mjs', import.meta.url)

  async function source() { return fs.readFile(serverUrl, 'utf8') }

  function route(text, start) {
    const lines = text.split('\n')
    const first = lines.findIndex((line) => line.includes(start))
    const last = lines.findIndex((line, index) => index > first && line.includes("url.pathname ==="))
    return lines.slice(first, last < 0 ? undefined : last).join('\n')
  }

  it('CA1: chatTurn escreve numa cópia com os auxiliares de chat', async () => {
    const text = await source()
    const chatTurn = text.slice(text.indexOf('async function chatTurn('), text.indexOf('// ---------- batedor'))
    for (const needle of ['chatWriteTurn(', 'chatCommand(', 'chatIntro(', 'formatHistory(', 'attachments:']) assert.ok(chatTurn.includes(needle))
    for (const needle of ['Só leitura', "'--permission-mode', 'plan'", "'--mode', 'plan'", "'read-only'"]) assert.ok(!chatTurn.includes(needle))
  })

  it('CA2: bloqueia nova pergunta enquanto uma proposta está pendente', async () => {
    const chatRoute = route(await source(), "url.pathname === '/api/chat' &&")
    assert.ok(chatRoute.indexOf('await e.chat_ready') < chatRoute.indexOf('pendingProposal(e.chat'))
    assert.ok(chatRoute.indexOf('pendingProposal(e.chat') < chatRoute.indexOf('PENDING_BLOCK'))
    assert.ok(chatRoute.indexOf('PENDING_BLOCK') < chatRoute.indexOf('chatTurn('))
  })

  it('CA3: engineFor espera carregar a conversa salva', async () => {
    const text = await source()
    const line = text.split('\n').find((entry) => entry.includes('function engineFor('))
    assert.ok(line?.includes('e.chat_ready = loadChat(key)'))
  })

  it('CA4: server.mjs passa na verificação sintática do Node', async () => {
    const error = await new Promise((resolve) => {
      execFile(process.execPath, ['--check', serverUrl.pathname.slice(1)], { maxBuffer: 1024 * 1024 }, resolve)
    })
    assert.equal(error, null)
  })
})

describe('chatWriteTurn', () => {
  it('CA1: cria uma proposta pendente com os arquivos alterados pela IA', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)

    const result = await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 't1',
      request: 'crie ola.txt',
      exec: async (wtPath) => {
        await fs.writeFile(path.join(wtPath, 'ola.txt'), 'oi')
        return 'Criei ola.txt.'
      },
      wtRoot
    })
    createdWorktrees.push({ repo, wtPath: path.join(wtRoot, 'chat-t1') })

    assert.equal(result.answer, 'Criei ola.txt.')
    assert.deepEqual(result.proposal.files, [{ path: 'ola.txt', kind: 'created' }])
    assert.equal(result.proposal.state, 'pending')
  })

  it('CA2: mantém o projeto original sem alterações após criar a proposta', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)

    await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 't1',
      request: 'crie ola.txt',
      exec: async (wtPath) => {
        await fs.writeFile(path.join(wtPath, 'ola.txt'), 'oi')
        return 'Criei ola.txt.'
      },
      wtRoot
    })
    createdWorktrees.push({ repo, wtPath: path.join(wtRoot, 'chat-t1') })

    await assert.rejects(fs.access(path.join(repo, 'ola.txt')), { code: 'ENOENT' })
    assert.equal((await gitCmd(['status', '--porcelain'], repo)).stdout, '')
  })

  it('CA3: descarta a cópia quando a IA não altera arquivos', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)

    const result = await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 't2',
      request: 'não mude nada',
      exec: async () => 'Nada a mudar.',
      wtRoot
    })

    assert.deepEqual(result, { answer: 'Nada a mudar.', proposal: null })
    await assert.rejects(fs.access(path.join(wtRoot, 'chat-t2')), { code: 'ENOENT' })
  })

  it('CA4: descarta a cópia e preserva o erro da IA', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)

    await assert.rejects(
      chatChanges.chatWriteTurn({
        projectDir: repo,
        id: 't3',
        request: 'falhe',
        exec: async () => { throw new Error('falhou') },
        wtRoot
      }),
      { message: 'falhou' }
    )
    await assert.rejects(fs.access(path.join(wtRoot, 'chat-t3')), { code: 'ENOENT' })
  })
})

describe('chatWriteTurn: anexos', () => {
  it('CA1: copia o anexo para a cópia antes de executar a IA', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)
    await fs.mkdir(path.join(repo, '.ade-attachments'), { recursive: true })
    await fs.writeFile(path.join(repo, '.ade-attachments', 'nota.txt'), 'x')
    let lido = ''

    const result = await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 'anexo-1',
      request: 'leia a nota',
      exec: async (wtPath) => {
        lido = await fs.readFile(path.join(wtPath, '.ade-attachments', 'nota.txt'), 'utf8')
        return 'Li a nota.'
      },
      wtRoot,
      attachments: ['.ade-attachments/nota.txt']
    })

    assert.equal(lido, 'x')
    assert.equal(result.proposal, null)
  })

  it('CA2: remove o anexo copiado antes de coletar a proposta', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)
    await fs.mkdir(path.join(repo, '.ade-attachments'), { recursive: true })
    await fs.writeFile(path.join(repo, '.ade-attachments', 'nota.txt'), 'x')

    const result = await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 'anexo-2',
      request: 'crie ola.txt',
      exec: async (wtPath) => {
        await fs.writeFile(path.join(wtPath, 'ola.txt'), 'oi')
        return 'Criei ola.txt.'
      },
      wtRoot,
      attachments: ['.ade-attachments/nota.txt']
    })
    createdWorktrees.push({ repo, wtPath: path.join(wtRoot, 'chat-anexo-2') })

    assert.deepEqual(result.proposal.files, [{ path: 'ola.txt', kind: 'created' }])
  })

  it('CA3: ignora anexos que escapam do projeto ou não existem', async () => {
    const repo = await makeRepo()
    const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))
    tempDirs.push(wtRoot)

    const result = await chatChanges.chatWriteTurn({
      projectDir: repo,
      id: 'anexo-3',
      request: 'não mude nada',
      exec: async () => 'Nada a mudar.',
      wtRoot,
      attachments: ['../fora.txt', '.ade-attachments/nao-existe.txt']
    })

    assert.deepEqual(result, { answer: 'Nada a mudar.', proposal: null })
    await assert.rejects(fs.access(path.join(wtRoot, 'fora.txt')), { code: 'ENOENT' })
  })
})

describe('chatIntro', () => {
  it('CA1: abre o chat em modo escrita na cópia isolada, sem modo somente leitura', () => {
    const intro = chatChanges.chatIntro({
      name: 'demo', dir: 'C:/proj', wtPath: 'C:/copia'
    })

    assert.ok(intro.includes('pode criar e alterar arquivos'))
    assert.ok(intro.includes('Não apague arquivos'))
    assert.ok(!intro.includes('alterar e apagar'))
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

describe('rejectChat', () => {
  it('CA1: recusa a proposta pendente sem alterar o repositório original', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'd1b2c3d4e5f6')

    const result = await chatChanges.rejectChat({ projectDir: repo, turns, id: proposal.id })

    assert.deepEqual(result, { status: 200, body: { ok: true } })
    assert.equal((await gitCmd(['status', '--porcelain', '--', '.'], repo)).stdout, '')
    await assert.rejects(fs.access(path.join(repo, 'ola.txt')), { code: 'ENOENT' })
    assert.equal(proposal.state, 'rejected')
    assert.match(proposal.decided_ts, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('CA2: remove a cópia isolada ao recusar a proposta', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'e1b2c3d4e5f6')

    await chatChanges.rejectChat({ projectDir: repo, turns, id: proposal.id })

    await assert.rejects(fs.access(proposal.wt), { code: 'ENOENT' })
  })

  it('CA3: devolve 404 para proposta inexistente sem decidir a pendente', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'f1b2c3d4e5f6')

    const result = await chatChanges.rejectChat({ projectDir: repo, turns, id: 'nao-existe' })

    assert.deepEqual(result, { status: 404, body: { error: 'Proposta não encontrada.' } })
    assert.equal(proposal.state, 'pending')
  })

  it('CA4: devolve 409 e preserva proposta já aplicada', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'g1b2c3d4e5f6')
    proposal.state = 'applied'

    const result = await chatChanges.rejectChat({ projectDir: repo, turns, id: proposal.id })

    assert.deepEqual(result, { status: 409, body: { error: 'Esta proposta já foi decidida.' } })
    assert.equal(proposal.state, 'applied')
  })
})

describe('approveChat', () => {
  it('CA1: aplica a proposta, cria o commit e remove a cópia isolada', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'a1b2c3d4e5f6')

    const result = await chatChanges.approveChat({
      projectDir: repo, turns, id: proposal.id, busy: false
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(await fs.readFile(path.join(repo, 'ola.txt'), 'utf8'), 'oi')
    assert.equal((await gitCmd(['log', '-1', '--format=%s'], repo)).stdout.trim(), 'chat: Criei ola.txt com o texto oi.')
    assert.equal(proposal.state, 'applied')
    assert.equal(proposal.commit, (await gitCmd(['rev-parse', 'HEAD'], repo)).stdout.trim())
    await assert.rejects(fs.access(proposal.wt), { code: 'ENOENT' })
  })

  it('CA2: bloqueia aprovação ocupada, suja ou desatualizada sem decidir a proposta', async () => {
    const busyRepo = await makeRepo()
    const busy = await makePendingProposal(busyRepo, 'b1b2c3d4e5f6')
    const busyResult = await chatChanges.approveChat({
      projectDir: busyRepo, turns: busy.turns, id: busy.proposal.id, busy: true
    })
    assert.deepEqual(busyResult, { status: 409, body: { error: chatChanges.MESSAGES.busy } })
    assert.equal(busy.proposal.state, 'pending')
    await assert.rejects(fs.access(path.join(busyRepo, 'ola.txt')), { code: 'ENOENT' })

    const dirtyRepo = await makeRepo()
    const dirty = await makePendingProposal(dirtyRepo, 'c1b2c3d4e5f6')
    await fs.writeFile(path.join(dirtyRepo, 'solto.txt'), 'solto')
    const dirtyResult = await chatChanges.approveChat({
      projectDir: dirtyRepo, turns: dirty.turns, id: dirty.proposal.id, busy: false
    })
    assert.deepEqual(dirtyResult, { status: 409, body: { error: chatChanges.MESSAGES.dirty } })
    assert.equal(dirty.proposal.state, 'pending')
    await assert.rejects(fs.access(path.join(dirtyRepo, 'ola.txt')), { code: 'ENOENT' })

    const staleRepo = await makeRepo()
    const stale = await makePendingProposal(staleRepo, 'd1b2c3d4e5f6')
    await fs.writeFile(path.join(staleRepo, 'z.txt'), 'z')
    await gitCmd(['add', 'z.txt'], staleRepo)
    await gitCmd(['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'novo'], staleRepo)
    const staleResult = await chatChanges.approveChat({
      projectDir: staleRepo, turns: stale.turns, id: stale.proposal.id, busy: false
    })
    assert.deepEqual(staleResult, { status: 409, body: { error: chatChanges.MESSAGES.stale } })
    assert.equal(stale.proposal.state, 'pending')
    await assert.rejects(fs.access(path.join(staleRepo, 'ola.txt')), { code: 'ENOENT' })
  })

  it('CA3: informa proposta ausente ou já decidida', async () => {
    const repo = await makeRepo()
    const { proposal, turns } = await makePendingProposal(repo, 'e1b2c3d4e5f6')

    const absent = await chatChanges.approveChat({
      projectDir: repo, turns, id: 'nao-existe', busy: false
    })
    assert.deepEqual(absent, { status: 404, body: { error: 'Proposta não encontrada.' } })

    proposal.state = 'rejected'
    const decided = await chatChanges.approveChat({
      projectDir: repo, turns, id: proposal.id, busy: false
    })
    assert.deepEqual(decided, { status: 409, body: { error: 'Esta proposta já foi decidida.' } })
  })

  it('CA4: desfaz aplicação parcial e mantém a cópia quando patch ou gancho falham', async () => {
    const conflictRepo = await makeRepo()
    const conflict = await makePendingProposal(conflictRepo, 'f1b2c3d4e5f6')
    const conflictHead = (await gitCmd(['rev-parse', 'HEAD'], conflictRepo)).stdout.trim()
    conflict.proposal.patch = 'diff --git a/nao.txt b/nao.txt\n--- a/nao.txt\n+++ b/nao.txt\n@@ -1 +1 @@\n-x\n+y\n'
    const conflictResult = await chatChanges.approveChat({
      projectDir: conflictRepo, turns: conflict.turns, id: conflict.proposal.id, busy: false
    })
    assert.deepEqual(conflictResult, { status: 409, body: { error: chatChanges.MESSAGES.conflict } })
    assert.equal((await gitCmd(['rev-parse', 'HEAD'], conflictRepo)).stdout.trim(), conflictHead)
    assert.equal(conflict.proposal.state, 'pending')
    await fs.access(conflict.proposal.wt)

    const hookRepo = await makeRepo()
    const hook = await makePendingProposal(hookRepo, 'g1b2c3d4e5f6')
    const hookDir = path.join(hookRepo, '.git', 'ade-fail-hooks')
    await fs.mkdir(hookDir)
    await fs.writeFile(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await gitCmd(['config', 'core.hooksPath', hookDir], hookRepo)
    const hookResult = await chatChanges.approveChat({
      projectDir: hookRepo, turns: hook.turns, id: hook.proposal.id, busy: false
    })
    assert.equal(hookResult.status, 409)
    assert.equal((await gitCmd(['status', '--porcelain'], hookRepo)).stdout, '')
    await assert.rejects(fs.access(path.join(hookRepo, 'ola.txt')), { code: 'ENOENT' })
    assert.equal(hook.proposal.state, 'pending')
    await fs.access(hook.proposal.wt)
  })
})
