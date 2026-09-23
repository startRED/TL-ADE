import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { startServer } from '../src/panel/server.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, freePort, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

type ServerDeps = NonNullable<NonNullable<Parameters<typeof startServer>[0]>['deps']>
type ChatAgent = NonNullable<ServerDeps['chatAgent']>
type AgentInput = Parameters<ChatAgent>[0]

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

function gitFixture() {
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'README.md'), '# fixture\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  cleanups.push(() => removeTmpDir(repo.dir))
  return repo
}

/** Agente dublê: grava no cwd recebido e responde; com `gate`, só termina quando a promessa resolve. */
function doubleAgent({ write = true, gate }: { write?: boolean; gate?: Promise<void> } = {}) {
  const calls: AgentInput[] = []
  const agent: ChatAgent = async (input) => {
    calls.push(input)
    if (gate) await gate
    if (write) {
      writeFileSync(path.join(input.cwd, 'README.md'), '# agenda\n')
      writeFileSync(path.join(input.cwd, 'nota.txt'), 'nova linha\n')
    }
    return { text: write ? 'Troquei o título e criei nota.txt.\nMais detalhes.' : 'O projeto tem só um README.' }
  }
  return { calls, agent }
}

async function serve(repoDir: string, chatAgent: ChatAgent) {
  const homeDir = makeTmpDir('ade-chat-home-')
  const server = await startServer({ repoDir, port: await freePort(), openBrowser: false, deps: { stdout: () => {}, homeDir, chatAgent } })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
    removeTmpDir(homeDir)
  }
  cleanups.push(close)
  const projectId = server.projects.list()[0].id
  const call = async (p: string, body?: unknown) => {
    const res = await apiRequest(server.port, p, { token: server.sessionToken, method: body === undefined ? 'GET' : 'POST', body })
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  const chat = `/api/projects/${encodeURIComponent(projectId)}/chat`
  const idle = () => expect.poll(async () => (await call(chat)).body.busy, { timeout: 30_000 }).toBe(false)
  return { server, projectId, call, chat, idle, close }
}

/** Pergunta e espera o turno acabar; devolve o turno do assistente. */
async function ask(s: Awaited<ReturnType<typeof serve>>, text = 'Troque o título do README') {
  const res = await s.call(s.chat, { text, family: 'claude', effort: 'medium' })
  expect(res.status).toBe(202)
  await s.idle()
  return (await s.call(s.chat)).body.turns.at(-1)
}

const descartadas = (repo: ReturnType<typeof makeRepo>) => repo.git(['for-each-ref', '--format=%(refname)', 'refs/ade/descartada']).trim().split('\n').filter(Boolean)

describe('painel: chat com cópia do projeto e cartão de permissão', () => {
  test('criterio_1_pergunta_responde_202_e_agente_roda_na_copia_em_ade_chat_wt', async () => {
    const repo = gitFixture()
    const { calls, agent } = doubleAgent()
    const s = await serve(repo.dir, agent)
    const res = await s.call(s.chat, { text: 'Troque o título', family: 'codex', model: 'gpt-6-sol', effort: 'high' })
    expect(res.status).toBe(202)
    await s.idle()
    expect(calls).toHaveLength(1)
    const rel = path.relative(path.join(repo.dir, '.ade', 'chat', 'wt'), calls[0].cwd)
    expect(rel && !rel.startsWith('..') && !path.isAbsolute(rel)).toBe(true)
    expect(calls[0]).toMatchObject({ family: 'codex', model: 'gpt-6-sol', effort: 'high', prompt: 'Troque o título' })
    // A pasta do projeto não recebeu a escrita do agente.
    expect(readFileSync(path.join(repo.dir, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect(existsSync(path.join(repo.dir, 'nota.txt'))).toBe(false)
  }, 60_000)

  test('criterio_2_pergunta_vazia_empresa_ou_esforco_invalidos_respondem_400', async () => {
    const repo = gitFixture()
    const { calls, agent } = doubleAgent()
    const s = await serve(repo.dir, agent)
    for (const body of [
      { text: '', family: 'claude' },
      { text: '   ', family: 'claude' },
      { text: 'oi', family: 'gpt' },
      { text: 'oi', family: 'claude', effort: 'turbo' },
    ]) {
      expect((await s.call(s.chat, body)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
    expect((await s.call(s.chat)).body).toEqual({ busy: false, turns: [] })
  }, 60_000)

  test('criterio_3_turno_em_execucao_impede_fechar_o_projeto_e_depois_fecha_e_solta_o_lease', async () => {
    const repo = gitFixture()
    let finish: () => void = () => {}
    const { agent } = doubleAgent({ gate: new Promise<void>((r) => { finish = r }) })
    const s = await serve(repo.dir, agent)
    const leasePath = path.join(repo.dir, '.ade', 'serve.lease')
    expect((await s.call(s.chat, { text: 'Troque o título', family: 'claude' })).status).toBe(202)
    expect((await s.call(s.chat)).body.busy).toBe(true)

    const refused = await s.call('/api/projects/close', { id: s.projectId })
    expect(refused.status).toBe(409)
    expect(s.server.projects.list().map((p) => p.id)).toContain(s.projectId)
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(process.pid)

    finish()
    await s.idle()
    expect((await s.call('/api/projects/close', { id: s.projectId })).status).toBe(200)
    expect(existsSync(leasePath)).toBe(false)
  }, 60_000)

  test('criterio_4_resposta_que_muda_arquivos_traz_proposta_pendente_com_resumo_e_diff', async () => {
    const repo = gitFixture()
    const s = await serve(repo.dir, doubleAgent().agent)
    const turn = await ask(s)
    const { turns } = (await s.call(s.chat)).body
    expect(turns.map((t: any) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[0].text).toBe('Troque o título do README')
    expect(turn.text).toBe('Troquei o título e criei nota.txt.\nMais detalhes.')
    expect(turn.proposal.status).toBe('pendente')
    expect(turn.proposal.summary).toBe('Troquei o título e criei nota.txt.')
    expect(turn.proposal.files.map((f: any) => f.file).sort()).toEqual(['README.md', 'nota.txt'])
    const readme = turn.proposal.files.find((f: any) => f.file === 'README.md')
    expect(readme.lines).toContainEqual({ kind: 'del', text: '# fixture' })
    expect(readme.lines).toContainEqual({ kind: 'add', text: '# agenda' })
    expect(turn.proposal.blocked_reason).toBeUndefined()
  }, 60_000)

  test('criterio_5_resposta_sem_mudanca_nao_tem_proposta', async () => {
    const repo = gitFixture()
    const s = await serve(repo.dir, doubleAgent({ write: false }).agent)
    const turn = await ask(s, 'O que tem no projeto?')
    expect(turn.role).toBe('assistant')
    expect(turn.text).toBe('O projeto tem só um README.')
    expect(turn.proposal).toBeUndefined()
    // Sem proposta, a pergunta seguinte é aceita.
    expect((await s.call(s.chat, { text: 'E agora?', family: 'agy' })).status).toBe(202)
    await s.idle()
  }, 60_000)

  test('criterio_6_proposta_pendente_bloqueia_pergunta_nova_com_409_em_portugues', async () => {
    const repo = gitFixture()
    const { calls, agent } = doubleAgent()
    const s = await serve(repo.dir, agent)
    await ask(s)
    const res = await s.call(s.chat, { text: 'Mais uma coisa', family: 'claude' })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Decida o cartão anterior (Aprovar ou Recusar) antes de perguntar de novo.')
    expect(calls).toHaveLength(1)
  }, 60_000)

  test('criterio_7_aprovar_com_projeto_limpo_vira_commit_e_proposta_aprovada', async () => {
    const repo = gitFixture()
    const s = await serve(repo.dir, doubleAgent().agent)
    const turn = await ask(s)
    const res = await s.call(`${s.chat}/approve`, { id: turn.id })
    expect(res.status).toBe(200)
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('chat: Troquei o título e criei nota.txt.')
    expect(repo.git(['rev-list', '--count', 'HEAD']).trim()).toBe('2')
    expect(readFileSync(path.join(repo.dir, 'README.md'), 'utf8')).toBe('# agenda\n')
    expect(readFileSync(path.join(repo.dir, 'nota.txt'), 'utf8')).toBe('nova linha\n')
    expect(repo.git(['status', '--porcelain']).trim()).toBe('')
    expect((await s.call(s.chat)).body.turns.at(-1).proposal.status).toBe('aprovada')
    // Decidida, a proposta não se aprova de novo e o chat aceita pergunta nova.
    expect((await s.call(`${s.chat}/approve`, { id: turn.id })).status).not.toBe(200)
    expect((await s.call(s.chat, { text: 'Outra', family: 'claude' })).status).toBe(202)
    await s.idle()
  }, 60_000)

  test('criterio_8_missao_rodando_projeto_sujo_ou_head_mudado_impedem_aprovar_com_409', async () => {
    const repo = gitFixture()
    const s = await serve(repo.dir, doubleAgent().agent)
    const turn = await ask(s)
    const head = repo.git(['rev-parse', 'HEAD']).trim()
    const approve = () => s.call(`${s.chat}/approve`, { id: turn.id })
    const reason = async () => (await s.call(s.chat)).body.turns.at(-1).proposal.blocked_reason

    const release = s.server.projects.beginActivity(s.projectId, 'mission')
    const busy = await approve()
    expect(busy.status).toBe(409)
    expect(busy.body.message).toMatch(/missão rodando/)
    expect(await reason()).toMatch(/missão rodando/)
    release()

    writeFileSync(path.join(repo.dir, 'solto.txt'), 'meu\n')
    const dirty = await approve()
    expect(dirty.status).toBe(409)
    expect(dirty.body.message).toMatch(/não commitadas/)
    expect(await reason()).toMatch(/não commitadas/)
    rmSync(path.join(repo.dir, 'solto.txt'))

    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(existsSync(path.join(repo.dir, 'nota.txt'))).toBe(false)

    writeFileSync(path.join(repo.dir, 'outro.txt'), 'x\n')
    repo.git(['add', '.'])
    repo.git(['commit', '-m', 'mudou por fora'])
    const moved = repo.git(['rev-parse', 'HEAD']).trim()
    const stale = await approve()
    expect(stale.status).toBe(409)
    expect(stale.body.message).toMatch(/mudou depois desta proposta/)
    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(moved)
    expect(existsSync(path.join(repo.dir, 'nota.txt'))).toBe(false)
    expect((await s.call(s.chat)).body.turns.at(-1).proposal.status).toBe('pendente')
  }, 60_000)

  test('criterio_9_recusar_guarda_a_arvore_em_ref_e_a_copia_volta_ao_head', async () => {
    const repo = gitFixture()
    const { calls, agent } = doubleAgent()
    const s = await serve(repo.dir, agent)
    const turn = await ask(s)
    expect(descartadas(repo)).toEqual([])
    expect((await s.call(`${s.chat}/reject`, { id: 'T-nao-existe' })).status).toBe(404)
    expect((await s.call(`${s.chat}/reject`, { id: turn.id })).status).toBe(200)

    const refs = descartadas(repo)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatch(/^refs\/ade\/descartada\/\d{8}T\d{9}Z$/)
    expect(repo.git(['show', `${refs[0]}:nota.txt`])).toBe('nova linha\n')
    const wt = calls[0].cwd
    expect(existsSync(path.join(wt, 'nota.txt'))).toBe(false)
    expect(readFileSync(path.join(wt, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect(repo.git(['-C', wt, 'status', '--porcelain']).trim()).toBe('')
    expect(repo.git(['-C', wt, 'rev-parse', 'HEAD']).trim()).toBe(repo.git(['rev-parse', 'HEAD']).trim())
    expect((await s.call(s.chat)).body.turns.at(-1).proposal.status).toBe('recusada')
    expect(repo.git(['rev-list', '--count', 'HEAD']).trim()).toBe('1')
  }, 60_000)

  test('criterio_10_limpar_guarda_a_arvore_em_ref_e_esvazia_o_historico', async () => {
    const repo = gitFixture()
    const s = await serve(repo.dir, doubleAgent().agent)
    await ask(s)
    expect((await s.call(`${s.chat}/clear`, {})).status).toBe(200)
    const refs = descartadas(repo)
    expect(refs).toHaveLength(1)
    expect(repo.git(['show', `${refs[0]}:README.md`])).toBe('# agenda\n')
    expect((await s.call(s.chat)).body).toEqual({ busy: false, turns: [] })
    expect((await s.call(s.chat, { text: 'De novo', family: 'claude' })).status).toBe(202)
    await s.idle()
  }, 60_000)

  test('criterio_11_reinicio_do_servidor_devolve_historico_e_proposta_pendente', async () => {
    const repo = gitFixture()
    const first = await serve(repo.dir, doubleAgent().agent)
    await ask(first)
    const before = (await first.call(first.chat)).body
    await first.close()

    const second = await serve(repo.dir, doubleAgent().agent)
    const after = (await second.call(second.chat)).body
    expect(after).toEqual(before)
    expect(after.turns.at(-1).proposal.status).toBe('pendente')
    expect((await second.call(second.chat, { text: 'Outra', family: 'claude' })).status).toBe(409)
    expect((await second.call(`${second.chat}/approve`, { id: after.turns.at(-1).id })).status).toBe(200)
    expect(readFileSync(path.join(repo.dir, 'nota.txt'), 'utf8')).toBe('nova linha\n')
  }, 60_000)

  test('criterio_12_no_navegador_pergunta_cartao_com_linhas_e_aprovar_mostra_aprovada_e_commita', async () => {
    const repo = gitFixture()
    const panel = await startPanelForTest({ repoDirs: [repo.dir], deps: { chatAgent: doubleAgent().agent } })
    cleanups.push(panel.close)
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByLabel('Pergunta ao chat').fill('Troque o título do README')
    await page.getByRole('button', { name: 'Perguntar' }).click()
    const card = page.getByRole('region', { name: 'Proposta de alteração' })
    await card.waitFor({ timeout: 30_000 })
    await expect.poll(() => card.locator('[data-kind="add"]').allTextContents()).toContain('+# agenda')
    expect(await card.locator('[data-kind="del"]').allTextContents()).toContain('-# fixture')
    await card.getByRole('button', { name: 'Aprovar' }).click()
    await card.getByText('aprovada').waitFor({ timeout: 30_000 })
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('chat: Troquei o título e criei nota.txt.')
    expect(ui.consoleErrors).toEqual([])
  }, 240_000)

  test('criterio_13_no_navegador_projeto_sujo_desativa_aprovar_e_mostra_o_motivo_em_texto', async () => {
    const repo = gitFixture()
    const panel = await startPanelForTest({ repoDirs: [repo.dir], deps: { chatAgent: doubleAgent().agent } })
    cleanups.push(panel.close)
    writeFileSync(path.join(repo.dir, 'solto.txt'), 'meu\n')
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByLabel('Pergunta ao chat').fill('Troque o título do README')
    await page.getByRole('button', { name: 'Perguntar' }).click()
    const card = page.getByRole('region', { name: 'Proposta de alteração' })
    await card.waitFor({ timeout: 30_000 })
    await card.getByText('A pasta tem alterações suas ainda não commitadas').waitFor()
    expect(await card.getByRole('button', { name: 'Aprovar' }).isDisabled()).toBe(true)
    expect(ui.consoleErrors).toEqual([])
  }, 240_000)
})
