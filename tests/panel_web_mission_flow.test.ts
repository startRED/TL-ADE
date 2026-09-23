import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { compileIntent } from '../src/intent/compiler.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { readJournal } from '../src/journal/journal.ts'
import { startServer } from '../src/panel/server.ts'
import { ensureFreshProbe } from '../src/panel/intake.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, freePort, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

type ServerDeps = NonNullable<NonNullable<Parameters<typeof startServer>[0]>['deps']>
type CompileInput = Parameters<NonNullable<ServerDeps['intent']>['compile']>[0]

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

function gitFixture(): string {
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'README.md'), '# fixture\n')
  writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }))
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  cleanups.push(() => removeTmpDir(repo.dir))
  return repo.dir
}

const QUESTIONS = [
  {
    id: 'Q1',
    unknown_ref: 'U1',
    kind: 'product_choice',
    text: 'Onde guardar os dados?',
    // A recomendada vem em segundo: o servidor a põe primeiro.
    options: [
      { id: 'arquivo', label: 'Arquivo JSON' },
      { id: 'sqlite', label: 'SQLite', recommended: true, why: 'já é dependência' },
    ],
  },
  ...['Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((id) => ({
    id,
    unknown_ref: `U-${id}`,
    kind: 'product_choice',
    text: `Pergunta ${id}?`,
    options: [
      { id: 'sim', label: 'Sim', recommended: true },
      { id: 'nao', label: 'Não' },
    ],
  })),
]

const BRIEFING = {
  title: 'Agenda',
  goal: 'Marcar compromissos.',
  users: 'Quem organiza a semana.',
  in_scope: ['cadastrar compromissos'],
  out_of_scope: ['aplicativo de celular'],
  done_means: ['compromisso criado aparece na lista'],
  constraints: [],
  versions: [
    { name: 'v1', goal: 'Cadastro básico', includes: ['cadastrar compromissos'] },
    { name: 'v2', goal: 'Lembretes', includes: ['lembrete por email'] },
  ],
}

// Opções na forma validada (autonomia do ADR 0015 e tetos em ceilings).
const OPTIONS_40_3 = { autonomy: 'safe', ceilings: { max_turns: 40, max_rounds: 3, usd_informative: null }, fast_lane: true, visual_gate: false, images: true, research: false }
const OPTIONS_12 = { ...OPTIONS_40_3, ceilings: { max_turns: 12, max_rounds: null, usd_informative: null } }

const DISCOVERY = {
  repo: { head: 'HEAD', dirty: false },
  scripts: { test: 'node --test' },
  languages: [{ name: 'javascript', share: 1 }],
  anchors: [],
  ui: { present: false },
}

/** Plano de verdade do compilador, com classificação dublê: approveMission o valida do disco. */
async function realPlan(request: string) {
  const advisor = async () => ({ complexity: 'bounded', confidence: 0.9, domains: ['backend'], rationale: 'dublê', cost: { usd: 0, model_calls: 1, model_id: 'dublê' } })
  const { plan, contracts } = await compileIntent({ request, discovery: DISCOVERY, advisor, unknowns: [] })
  return { plan, contracts }
}

/** Porta de intenção dublê: perguntas na primeira chamada; depois briefing (se large) ou plano. */
function intentDouble({ questions = QUESTIONS, large = true }: { questions?: unknown[]; large?: boolean } = {}) {
  const calls: CompileInput[] = []
  return {
    calls,
    intent: {
      async compile(input: CompileInput) {
        calls.push(input)
        if (!input.answers && questions.length > 0) return { questions: structuredClone(questions) }
        if (large && !input.briefing) return { briefing: structuredClone(BRIEFING) }
        return realPlan(input.request)
      },
    },
  }
}

function runDouble() {
  const calls: Array<{ repoDir: string; missionId: string; planPath: string; options: unknown }> = []
  let finish: (err?: Error) => void = () => {}
  return {
    calls,
    finish: (err?: Error) => finish(err),
    runMission: (args: { repoDir: string; missionId: string; planPath: string; options: unknown }) => {
      calls.push(args)
      return new Promise<void>((resolve, reject) => { finish = (err) => (err ? reject(err) : resolve()) })
    },
  }
}

async function serve(repoDir: string, deps: ServerDeps) {
  const homeDir = makeTmpDir('ade-home-')
  const server = await startServer({ repoDir, port: await freePort(), openBrowser: false, deps: { stdout: () => {}, homeDir, ...deps } })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
    removeTmpDir(homeDir)
  }
  cleanups.push(close)
  const projectId = server.projects.list()[0].id
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await apiRequest(server.port, p, { method, token: server.sessionToken, body })
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  const base = `/api/projects/${encodeURIComponent(projectId)}`
  return {
    server,
    projectId,
    close,
    call,
    request: (text: unknown, id = projectId) => call('POST', `/api/projects/${encodeURIComponent(id)}/requests`, { text }),
    intake: (id = projectId) => call('GET', `/api/projects/${encodeURIComponent(id)}/intake`),
    post: (sub: string, body: unknown) => call('POST', `${base}/intake/${sub}`, body),
  }
}

const decisionsOf = (repoDir: string, missionId: string) => {
  const journalPath = path.join(repoDir, '.ade', 'missions', missionId, 'journal.jsonl')
  if (!existsSync(journalPath)) return []
  return readJournal(journalPath).events.filter((e) => e.kind === 'decision')
}

const missionDirs = (repoDir: string) => {
  const dir = path.join(repoDir, '.ade', 'missions')
  return existsSync(dir) ? readdirSync(dir) : []
}

/** Leva um pedido até a etapa pedida (grande: entrevista → briefing → plano). */
async function reach(s: Awaited<ReturnType<typeof serve>>, stage: 'interview' | 'briefing' | 'plan') {
  const res = await s.request('Crie uma agenda de compromissos')
  expect(res.status).toBe(202)
  if (stage === 'interview') return res.body.mission_id as string
  expect((await s.post('interview', { answers: {} })).status).toBe(200)
  if (stage === 'briefing') return res.body.mission_id as string
  const { body } = await s.intake()
  expect((await s.post('briefing/approve', { digest: body.digest })).status).toBe(200)
  return res.body.mission_id as string
}

describe('pedido, entrevista, briefing, plano e aprovação no painel', () => {
  test('criterio_1_pedido_sem_intake_vivo_responde_202_e_porta_recebe_pedido_e_opcoes', async () => {
    const repo = gitFixture()
    mkdirSync(path.join(repo, '.ade'), { recursive: true })
    writeFileSync(path.join(repo, '.ade', 'options.json'), JSON.stringify(OPTIONS_40_3))
    const double = intentDouble()
    const s = await serve(repo, { intent: double.intent, runMission: runDouble().runMission })

    const res = await s.request('Crie uma agenda de compromissos')
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ mission_id: expect.stringMatching(/^mission-/) })
    expect(double.calls).toHaveLength(1)
    expect(double.calls[0]).toMatchObject({
      request: 'Crie uma agenda de compromissos',
      repoDir: path.resolve(repo),
      options: OPTIONS_40_3,
    })
    expect(double.calls[0].answers).toBeUndefined()
  })

  test('criterio_2_texto_vazio_ou_so_espacos_responde_400_e_nao_cria_missao', async () => {
    const repo = gitFixture()
    const double = intentDouble()
    const s = await serve(repo, { intent: double.intent, runMission: runDouble().runMission })
    for (const text of ['', '   \n\t ', 42, undefined]) {
      const res = await s.request(text)
      expect(res.status, String(text)).toBe(400)
      expect(res.body.message).toEqual(expect.any(String))
    }
    expect(double.calls).toHaveLength(0)
    expect(missionDirs(repo)).toEqual([])
    expect((await s.intake()).status).toBe(404)
    expect(await s.call('GET', `/api/projects/${encodeURIComponent(s.projectId)}/intake?if_missing=null`)).toEqual({ status: 200, body: null })
  })

  test('criterio_3_intake_vivo_bloqueia_pedido_novo_com_409_e_outro_projeto_aceita', async () => {
    const repo = gitFixture()
    const other = gitFixture()
    const run = runDouble()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: run.runMission })
    const otherProject = await s.server.projects.open(other)

    const missionId = await reach(s, 'interview')
    const expectedByStage = {
      interview: { error: 'entrevista_pendente', message: expect.stringMatching(/entrevista/) },
      briefing: { error: 'briefing_pendente', message: expect.stringMatching(/briefing/) },
      plan: { error: 'plano_pendente', message: 'Já existe um plano esperando aprovação neste projeto.' },
      running: { error: 'missao_em_execucao', message: expect.stringMatching(/execução/) },
    }
    const expectBlocked = async (stage: keyof typeof expectedByStage) => {
      const before = (await s.intake()).body
      expect(before.stage).toBe(stage)
      const res = await s.request('Outro pedido qualquer')
      expect(res.status).toBe(409)
      expect(res.body).toEqual(expectedByStage[stage])
      expect((await s.intake()).body).toEqual(before)
    }

    await expectBlocked('interview')
    await s.post('interview', { answers: {} })
    await expectBlocked('briefing')
    await s.post('briefing/approve', { digest: (await s.intake()).body.digest })
    await expectBlocked('plan')
    await s.post('plan/approve', { digest: (await s.intake()).body.digest })
    await expectBlocked('running')
    expect(missionDirs(repo)).toEqual([missionId])

    const res = await s.request('Pedido em outra pasta', otherProject.id)
    expect(res.status).toBe(202)
    expect((await s.intake(otherProject.id)).body.mission_id).toBe(res.body.mission_id)
    run.finish()
  })

  test('criterio_4_depois_de_recusa_ou_missao_terminada_pedido_novo_ganha_mission_id_novo', async () => {
    const repo = gitFixture()
    const run = runDouble()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: run.runMission })

    const first = await reach(s, 'briefing')
    expect((await s.post('briefing/reject', { reason: 'escopo errado' })).status).toBe(200)
    const second = await s.request('Crie uma agenda de compromissos')
    expect(second.status).toBe(202)
    expect(second.body.mission_id).not.toBe(first)
    expect((await s.intake()).body).toMatchObject({ mission_id: second.body.mission_id, stage: 'interview' })

    await s.post('interview', { answers: {} })
    await s.post('briefing/approve', { digest: (await s.intake()).body.digest })
    await s.post('plan/approve', { digest: (await s.intake()).body.digest })
    run.finish()
    await expect.poll(async () => (await s.intake()).body.stage).toBe('concluida')

    const third = await s.request('Mais um pedido')
    expect(third.status).toBe(202)
    expect([first, second.body.mission_id]).not.toContain(third.body.mission_id)
    expect((await s.intake()).body.mission_id).toBe(third.body.mission_id)
  })

  test('criterio_5_entrevista_tem_no_maximo_5_perguntas_com_a_recomendada_primeiro', async () => {
    const s = await serve(gitFixture(), { intent: intentDouble().intent, runMission: runDouble().runMission })
    await reach(s, 'interview')
    const { status, body } = await s.intake()
    expect(status).toBe(200)
    expect(body.stage).toBe('interview')
    expect(body.questions).toHaveLength(5)
    for (const q of body.questions) expect(q.options[0].recommended).toBe(true)
    expect(body.questions[0].options.map((o: { id: string }) => o.id)).toEqual(['sqlite', 'arquivo'])
  })

  test('criterio_6_respostas_viram_decisoes_com_origem_e_intake_avanca', async () => {
    const repo = gitFixture()
    const double = intentDouble()
    const s = await serve(repo, { intent: double.intent, runMission: runDouble().runMission })
    await reach(s, 'interview')

    // Opção que não existe falha fechado sem mudar a etapa.
    const bad = await s.post('interview', { answers: { Q1: 'inventada' } })
    expect(bad.status).toBe(400)
    expect((await s.intake()).body.stage).toBe('interview')

    const res = await s.post('interview', { answers: { Q1: 'arquivo' } })
    expect(res.status).toBe(200)
    expect(res.body.stage).toBe('briefing')
    expect(res.body.decisions).toContainEqual(expect.objectContaining({ question_id: 'Q1', value: 'arquivo', origin: 'usuario' }))
    expect(res.body.decisions).toContainEqual(expect.objectContaining({ question_id: 'Q2', value: 'sim', origin: 'padrao' }))
    for (const d of res.body.decisions) expect(['usuario', 'ia_supondo', 'padrao']).toContain(d.origin)
    expect(double.calls.at(-1)?.answers).toEqual({ Q1: 'arquivo' })

    // Pedido pequeno vai direto ao plano.
    const small = await serve(gitFixture(), { intent: intentDouble({ large: false }).intent, runMission: runDouble().runMission })
    await small.request('Corrija o título')
    const planned = await small.post('interview', { answers: {} })
    expect(planned.body.stage).toBe('plan')
    expect(planned.body.plan).toBeTruthy()
  })

  test('criterio_7_briefing_aprovado_com_digest_certo_vai_ao_plano_e_desatualizado_responde_409', async () => {
    const repo = gitFixture()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: runDouble().runMission })
    const missionId = await reach(s, 'briefing')
    const pending = (await s.intake()).body
    expect(pending.briefing).toEqual(BRIEFING)
    expect(pending.digest).toBe(digest16(BRIEFING))

    const stale = await s.post('briefing/approve', { digest: '0000000000000000' })
    expect(stale.status).toBe(409)
    expect((await s.intake()).body).toEqual(pending)

    const ok = await s.post('briefing/approve', { digest: pending.digest })
    expect(ok.status).toBe(200)
    const after = (await s.intake()).body
    expect(after.stage).toBe('plan')
    expect(after.parts.length).toBeGreaterThan(0)
    for (const part of after.parts) expect(part.criteria.length).toBeGreaterThan(0)
    expect(decisionsOf(repo, missionId).map((e) => e.data.decision)).toEqual(['briefing_approved'])
  })

  test('criterio_8_recusa_do_briefing_registra_motivo_e_nao_gera_nem_executa_plano', async () => {
    const repo = gitFixture()
    const double = intentDouble()
    const run = runDouble()
    const s = await serve(repo, { intent: double.intent, runMission: run.runMission })
    const missionId = await reach(s, 'briefing')
    const callsBefore = double.calls.length

    const res = await s.post('briefing/reject', { reason: 'Não quero lembretes' })
    expect(res.status).toBe(200)
    expect((await s.intake()).body).toMatchObject({ mission_id: missionId, stage: 'recusada', rejected_at: 'briefing', reason: 'Não quero lembretes' })
    expect(decisionsOf(repo, missionId)).toContainEqual(expect.objectContaining({
      source: 'panel',
      data: { decision: 'briefing_rejected', reason: 'Não quero lembretes' },
    }))
    expect(double.calls).toHaveLength(callsBefore)
    expect(existsSync(path.join(repo, '.ade', 'missions', missionId, 'plan.json'))).toBe(false)
    expect(run.calls).toHaveLength(0)
    expect((await s.request('Pedido novo')).status).toBe(202)
  })

  test('criterio_9_recusa_com_motivo_vazio_ou_na_etapa_errada_nao_muda_o_intake', async () => {
    const s = await serve(gitFixture(), { intent: intentDouble().intent, runMission: runDouble().runMission })
    await reach(s, 'briefing')
    let snapshot = (await s.intake()).body
    for (const reason of ['', '   ', undefined]) {
      expect((await s.post('briefing/reject', { reason })).status).toBe(400)
      expect((await s.intake()).body).toEqual(snapshot)
    }
    // Recusa de plano com o intake em 'briefing' é etapa errada.
    expect((await s.post('plan/reject', { reason: 'não' })).status).toBe(409)
    expect((await s.intake()).body).toEqual(snapshot)

    await s.post('briefing/approve', { digest: snapshot.digest })
    snapshot = (await s.intake()).body
    expect(snapshot.stage).toBe('plan')
    expect((await s.post('briefing/reject', { reason: 'tarde demais' })).status).toBe(409)
    expect((await s.post('plan/reject', { reason: ' ' })).status).toBe(400)
    expect((await s.intake()).body).toEqual(snapshot)
  })

  test('criterio_10_plano_aprovado_registra_source_panel_chama_execucao_uma_vez_com_atividade', async () => {
    const repo = gitFixture()
    mkdirSync(path.join(repo, '.ade'), { recursive: true })
    writeFileSync(path.join(repo, '.ade', 'options.json'), JSON.stringify(OPTIONS_12))
    const run = runDouble()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: run.runMission })
    const missionId = await reach(s, 'plan')
    const { digest } = (await s.intake()).body

    const res = await s.post('plan/approve', { digest })
    expect(res.status).toBe(200)
    // Segundo clique não executa de novo.
    expect((await s.post('plan/approve', { digest })).status).toBe(409)

    const missionDir = path.join(repo, '.ade', 'missions', missionId)
    const approval = decisionsOf(repo, missionId).find((e) => e.data.decision === 'plan_approved')
    expect(approval).toMatchObject({ source: 'panel', data: { digest } })
    expect(run.calls).toEqual([{ repoDir: path.resolve(repo), missionId, planPath: path.join(missionDir, 'plan.json'), options: OPTIONS_12 }])
    expect(JSON.parse(readFileSync(path.join(missionDir, 'mission-options.json'), 'utf8'))).toEqual(OPTIONS_12)
    expect((await s.intake()).body.stage).toBe('running')
    expect(s.server.projects.hasActivity(s.projectId)).toBe(true)
    expect((await s.call('POST', '/api/projects/close', { id: s.projectId })).status).toBe(409)

    run.finish()
    await expect.poll(() => s.server.projects.hasActivity(s.projectId)).toBe(false)
    expect((await s.intake()).body.stage).toBe('concluida')
    expect(run.calls).toHaveLength(1)
  })

  test('criterio_10b_execucao_que_falha_libera_a_atividade_e_guarda_o_erro', async () => {
    const run = runDouble()
    const s = await serve(gitFixture(), { intent: intentDouble({ large: false }).intent, runMission: run.runMission })
    await s.request('Corrija o título')
    await s.post('interview', { answers: {} })
    await s.post('plan/approve', { digest: (await s.intake()).body.digest })
    run.finish(new Error('ade run saiu com código 3'))
    await expect.poll(() => s.server.projects.hasActivity(s.projectId)).toBe(false)
    expect((await s.intake()).body).toMatchObject({ stage: 'concluida', error: 'ade run saiu com código 3' })
  })

  test('criterio_11_recusa_do_plano_registra_motivo_e_nao_executa', async () => {
    const repo = gitFixture()
    const run = runDouble()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: run.runMission })
    const missionId = await reach(s, 'plan')

    const res = await s.post('plan/reject', { reason: 'Partes grandes demais' })
    expect(res.status).toBe(200)
    expect((await s.intake()).body).toMatchObject({ stage: 'recusada', rejected_at: 'plan', reason: 'Partes grandes demais' })
    const decisions = decisionsOf(repo, missionId).map((e) => e.data)
    expect(decisions).toContainEqual({ decision: 'plan_rejected', reason: 'Partes grandes demais' })
    expect(decisions.some((d) => d.decision === 'plan_approved')).toBe(false)
    expect(run.calls).toHaveLength(0)
    expect((await s.request('Pedido novo')).status).toBe(202)
  })

  test('criterio_12_nenhuma_opcao_aprova_briefing_ou_plano_sem_clique', async () => {
    const repo = gitFixture()
    mkdirSync(path.join(repo, '.ade'), { recursive: true })
    writeFileSync(path.join(repo, '.ade', 'options.json'), JSON.stringify({ ...OPTIONS_12, autonomy: 'restricted', fast_lane: true }))
    const run = runDouble()
    const s = await serve(repo, { intent: intentDouble().intent, runMission: run.runMission })
    const missionId = await reach(s, 'briefing')
    await new Promise((r) => setTimeout(r, 100))
    expect((await s.intake()).body.stage).toBe('briefing')
    expect(decisionsOf(repo, missionId)).toEqual([])

    await s.post('briefing/approve', { digest: (await s.intake()).body.digest })
    await new Promise((r) => setTimeout(r, 100))
    expect((await s.intake()).body.stage).toBe('plan')
    expect(decisionsOf(repo, missionId).map((e) => e.data.decision)).toEqual(['briefing_approved'])
    expect(run.calls).toHaveLength(0)
  })

  test('criterio_13_reinicio_devolve_a_mesma_etapa_e_conteudo_e_mantem_o_409', async () => {
    const repo = gitFixture()
    for (const stage of ['interview', 'plan'] as const) {
      const first = await serve(repo, { intent: intentDouble().intent, runMission: runDouble().runMission })
      await reach(first, stage)
      const before = (await first.intake()).body
      expect(before.stage).toBe(stage)
      await first.close()

      const again = await serve(repo, { intent: intentDouble().intent, runMission: runDouble().runMission })
      expect((await again.intake()).body).toEqual(before)
      const blocked = await again.request('Outro pedido')
      expect(blocked.status).toBe(409)
      expect((await again.intake()).body).toEqual(before)
      // Libera para a próxima rodada do laço.
      await again.post(`${stage === 'plan' ? 'plan' : 'briefing'}/reject`, { reason: 'fim' })
      if (stage === 'interview') {
        await again.post('interview', { answers: {} })
        await again.post('briefing/reject', { reason: 'fim' })
      }
      await again.close()
    }
  })

  test('criterio_13b_intake_gravado_com_id_diferente_da_pasta_falha_alto', async () => {
    const repo = gitFixture()
    const dir = path.join(repo, '.ade', 'missions', 'mission-aaa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'intake.json'), JSON.stringify({ mission_id: 'mission-bbb', stage: 'interview', created_at: '2026-09-23T00:00:00.000Z' }))
    const s = await serve(repo, { intent: intentDouble().intent, runMission: runDouble().runMission })
    const res = await s.intake()
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/mission-bbb/)
  })

  test('criterio_14_no_navegador_pedido_entrevista_briefing_e_plano_chegam_a_execucao', async () => {
    const run = runDouble()
    const panel = await startPanelForTest({ repoDirs: [gitFixture()], deps: { intent: intentDouble().intent, runMission: run.runMission } })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByLabel('Pedido').fill('Crie uma agenda de compromissos')
    await page.getByRole('button', { name: 'Enviar pedido' }).click()
    await page.getByRole('heading', { name: 'Entrevista' }).waitFor()
    await expect.poll(() => page.getByText('recomendado').count()).toBe(5)
    await page.getByRole('radio', { name: /Arquivo JSON/ }).check()
    await page.getByRole('button', { name: 'Responder' }).click()

    await page.getByRole('heading', { name: 'Briefing' }).waitFor()
    await page.getByText('aplicativo de celular').waitFor()
    await page.getByRole('button', { name: 'Aprovar briefing' }).click()

    await page.getByRole('heading', { name: 'Plano' }).waitFor()
    await page.getByRole('button', { name: 'Aprovar plano' }).click()

    await page.getByRole('heading', { name: 'Missão em execução' }).waitFor()
    expect(run.calls).toHaveLength(1)
    expect(ui.consoleErrors).toEqual([])
    run.finish()
  }, 180_000)

  test('criterio_15_no_navegador_recusar_briefing_volta_para_a_caixa_de_pedido', async () => {
    const panel = await startPanelForTest({ repoDirs: [gitFixture()], deps: { intent: intentDouble({ questions: [] }).intent, runMission: runDouble().runMission } })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByLabel('Pedido').fill('Crie uma agenda de compromissos')
    await page.getByRole('button', { name: 'Enviar pedido' }).click()
    await page.getByRole('heading', { name: 'Briefing' }).waitFor()
    await page.getByLabel('Motivo da recusa').fill('Escopo grande demais')
    await page.getByRole('button', { name: 'Recusar briefing' }).click()

    await page.getByLabel('Pedido').waitFor()
    await page.getByText('O briefing foi recusado: Escopo grande demais').waitFor()
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)

  test('criterio_16_no_navegador_recusar_plano_volta_para_a_caixa_de_pedido', async () => {
    const panel = await startPanelForTest({ repoDirs: [gitFixture()], deps: { intent: intentDouble({ questions: [], large: false }).intent, runMission: runDouble().runMission } })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByLabel('Pedido').fill('Corrija o título')
    await page.getByRole('button', { name: 'Enviar pedido' }).click()
    await page.getByRole('heading', { name: 'Plano' }).waitFor()
    await page.getByLabel('Motivo da recusa').fill('Faltou prova')
    await page.getByRole('button', { name: 'Recusar plano' }).click()

    await page.getByLabel('Pedido').waitFor()
    await page.getByText('O plano foi recusado: Faltou prova').waitFor()
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)

  test('antes_de_rodar_o_painel_renova_a_sonda_do_doctor_que_falta_ou_venceu', async () => {
    const home = makeTmpDir('ade-probe-home-')
    cleanups.push(() => removeTmpDir(home))
    let runs = 0
    const runDoctor = async () => { runs++ }
    expect(await ensureFreshProbe({ homeDir: home, now: Date.parse('2026-09-23T12:00:00Z'), runDoctor })).toBe(true)
    mkdirSync(path.join(home, '.ade'), { recursive: true })
    writeFileSync(path.join(home, '.ade', 'capabilities.json'), JSON.stringify({ probe_ok: true, probed_at: '2026-09-23T10:00:00Z' }))
    expect(await ensureFreshProbe({ homeDir: home, now: Date.parse('2026-09-23T12:00:00Z'), runDoctor })).toBe(false)
    expect(await ensureFreshProbe({ homeDir: home, now: Date.parse('2026-09-25T12:00:00Z'), runDoctor })).toBe(true)
    expect(runs).toBe(2)
  })
})
