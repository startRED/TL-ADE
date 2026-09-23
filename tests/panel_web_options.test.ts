import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { runStory } from '../src/engine.ts'
import { compileIntent } from '../src/intent/compiler.ts'
import { listCatalog } from '../src/skills/catalog.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { startServer } from '../src/panel/server.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, freePort, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

type ServerDeps = NonNullable<NonNullable<Parameters<typeof startServer>[0]>['deps']>
type CompileInput = Parameters<NonNullable<ServerDeps['intent']>['compile']>[0]
type RunArgs = Parameters<NonNullable<ServerDeps['runMission']>>[0]

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

const VALID = {
  autonomy: 'controlled',
  ceilings: { max_turns: 12, max_rounds: 2, usd_informative: 0.5 },
  fast_lane: false,
  visual_gate: true,
  images: false,
  research: true,
}

const ENTRIES = [
  { id: 'tdd', name: 'tdd', description: 'Prova antes do código', domains: ['testing'], source: 'acme', commit: 'c1', trust: 'allowlisted' },
  { id: 'react-ui', name: 'react-ui', description: 'Telas em React', domains: ['frontend'], source: 'acme', commit: 'c1', trust: 'allowlisted' },
  { id: 'api-rest', name: 'api-rest', description: 'Rotas REST', domains: ['backend'], source: 'outra', commit: 'c2', trust: 'allowlisted' },
  { id: 'risky', name: 'risky', description: 'Em quarentena', domains: ['backend'], source: 'outra', commit: 'c2', trust: 'quarantine' },
]

/** Catálogo de fixture: índice mais o SKILL.md de cada skill na pasta da fonte pinada. */
function catalogFixture(): string {
  const dir = makeTmpDir('ade-catalog-')
  cleanups.push(() => removeTmpDir(dir))
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ entries: ENTRIES }))
  for (const e of ENTRIES) {
    const skillDir = path.join(dir, 'sources', `${e.source}@${e.commit}`, 'skills', e.id)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${e.id}\n---\n\nCorpo da skill ${e.id}: escreva a prova primeiro.\n`)
  }
  return dir
}

function gitFixture(): string {
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo.dir, 'README.md'), '# fixture\n')
  fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }))
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  cleanups.push(() => removeTmpDir(repo.dir))
  return repo.dir
}

const DISCOVERY = {
  repo: { head: 'HEAD', dirty: false },
  scripts: { test: 'node --test' },
  languages: [{ name: 'javascript', share: 1 }],
  anchors: [],
  ui: { present: false },
}

/** Porta de intenção dublê que devolve direto um plano de verdade do compilador. */
function planIntent() {
  const calls: CompileInput[] = []
  return {
    calls,
    intent: {
      async compile(input: CompileInput) {
        calls.push(input)
        const advisor = async () => ({ complexity: 'bounded', confidence: 0.9, domains: ['backend'], rationale: 'dublê', cost: { usd: 0, model_calls: 1, model_id: 'dublê' } })
        const { plan, contracts } = await compileIntent({ request: input.request, discovery: DISCOVERY, advisor, unknowns: [] })
        return { plan, contracts }
      },
    },
  }
}

function runDouble() {
  const calls: RunArgs[] = []
  const pending: Array<() => void> = []
  return {
    calls,
    finishAll: () => { for (const done of pending.splice(0)) done() },
    runMission: (args: RunArgs) => {
      calls.push(structuredClone(args))
      return new Promise<void>((resolve) => { pending.push(resolve) })
    },
  }
}

async function serve(repoDirs: string[], deps: ServerDeps) {
  const homeDir = makeTmpDir('ade-home-')
  const server = await startServer({ repoDir: repoDirs[0], port: await freePort(), openBrowser: false, deps: { stdout: () => {}, homeDir, ...deps } })
  for (const dir of repoDirs.slice(1)) await server.projects.open(dir)
  cleanups.push(async () => {
    await server.close()
    removeTmpDir(homeDir)
  })
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await apiRequest(server.port, p, { method, token: server.sessionToken, body })
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  const ids = server.projects.list().map((p) => p.id)
  const base = (id = ids[0]) => `/api/projects/${encodeURIComponent(id)}`
  return { server, ids, call, base }
}

describe('skills, plugins e opções no servidor do painel', () => {
  test('criterio_1_get_skills_com_filtros_devolve_o_mesmo_que_listCatalog', async () => {
    const catalogDir = catalogFixture()
    const s = await serve([gitFixture()], { catalogDir })
    const index = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8'))
    const cases: Array<Record<string, string>> = [{}, { domain: 'backend' }, { trust: 'quarantine' }, { source: 'acme' }, { domain: 'backend', trust: 'allowlisted' }]
    for (const filters of cases) {
      const res = await s.call('GET', `/api/skills?${new URLSearchParams(filters)}`)
      expect(res.status).toBe(200)
      expect(res.body.map((e: { id: string }) => e.id)).toEqual(listCatalog({ index, ...filters }).map((e) => e.id))
    }
    const one = await s.call('GET', '/api/skills?domain=testing')
    expect(one.body).toEqual([{ id: 'tdd', domain: 'testing', trust: 'allowlisted', source: 'acme', summary: 'Prova antes do código' }])
  })

  test('criterio_2_get_skill_por_id_traz_o_corpo_e_id_desconhecido_responde_404', async () => {
    const s = await serve([gitFixture()], { catalogDir: catalogFixture() })
    const res = await s.call('GET', '/api/skills/tdd')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'tdd', body: 'Corpo da skill tdd: escreva a prova primeiro.' })
    expect((await s.call('GET', '/api/skills/nao-existe')).status).toBe(404)
  })

  test('criterio_3_fonte_desligada_fica_fora_das_skills_elegiveis_do_proximo_pedido', async () => {
    const double = planIntent()
    const s = await serve([gitFixture()], { catalogDir: catalogFixture(), intent: double.intent, runMission: runDouble().runMission })
    const before = await s.call('GET', `${s.base()}/plugins`)
    expect(before.body).toEqual([
      { source: 'acme', enabled: true, skills: 2 },
      { source: 'outra', enabled: true, skills: 2 },
    ])
    expect((await s.call('POST', `${s.base()}/plugins`, { source: 'acme', enabled: false })).status).toBe(200)
    expect((await s.call('GET', `${s.base()}/plugins`)).body[0]).toEqual({ source: 'acme', enabled: false, skills: 2 })
    expect((await s.call('POST', `${s.base()}/plugins`, { source: 'fantasma', enabled: false })).status).toBe(400)
    expect((await s.call('POST', `${s.base()}/plugins`, { source: 'outra', enabled: 'sim' })).status).toBe(400)

    expect((await s.call('POST', `${s.base()}/requests`, { text: 'Corrija o título' })).status).toBe(202)
    const eligible = double.calls[0].eligibleSkills.map((e) => e.id)
    expect(eligible).toEqual(['api-rest'])
    expect(double.calls[0].eligibleSkills.some((e) => e.source === 'acme')).toBe(false)
  })

  test('criterio_4_post_options_validas_voltam_no_get_e_ficam_em_ade_options_json', async () => {
    const repo = gitFixture()
    const s = await serve([repo], {})
    const saved = await s.call('POST', `${s.base()}/options`, VALID)
    expect(saved.status).toBe(200)
    expect((await s.call('GET', `${s.base()}/options`)).body).toEqual(VALID)
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.ade', 'options.json'), 'utf8'))).toEqual(VALID)
  })

  test('criterio_5_autonomia_fora_do_adr_teto_negativo_ou_quebrado_e_campo_desconhecido_respondem_400', async () => {
    const repo = gitFixture()
    const s = await serve([repo], {})
    expect((await s.call('POST', `${s.base()}/options`, VALID)).status).toBe(200)
    const invalid = [
      { ...VALID, autonomy: 'total' },
      { ...VALID, ceilings: { ...VALID.ceilings, max_turns: -1 } },
      { ...VALID, ceilings: { ...VALID.ceilings, max_rounds: 1.5 } },
      { ...VALID, ceilings: { ...VALID.ceilings, usd_informative: -3 } },
      { ...VALID, auto_approve: true },
      { ...VALID, ceilings: { ...VALID.ceilings, extra: 1 } },
      { ...VALID, fast_lane: 'sim' },
      [],
    ]
    for (const body of invalid) {
      const res = await s.call('POST', `${s.base()}/options`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.message).toEqual(expect.any(String))
    }
    expect((await s.call('GET', `${s.base()}/options`)).body).toEqual(VALID)
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.ade', 'options.json'), 'utf8'))).toEqual(VALID)
  })

  test('criterio_6_opcoes_salvas_chegam_a_porta_de_intencao_e_nao_vazam_para_outro_projeto', async () => {
    const [a, b] = [gitFixture(), gitFixture()]
    const double = planIntent()
    const s = await serve([a, b], { intent: double.intent, runMission: runDouble().runMission })
    const other = await s.call('GET', `${s.base(s.ids[1])}/options`)
    expect((await s.call('POST', `${s.base()}/options`, VALID)).status).toBe(200)
    expect((await s.call('POST', `${s.base()}/requests`, { text: 'Corrija o título' })).status).toBe(202)
    expect(double.calls[0].options).toEqual(VALID)
    expect((await s.call('GET', `${s.base(s.ids[1])}/options`)).body).toEqual(other.body)
    expect(other.body).not.toEqual(VALID)
    expect(fs.existsSync(path.join(b, '.ade', 'options.json'))).toBe(false)
  })

  test('criterio_7_aprovar_o_plano_fixa_as_opcoes_na_missao_e_entrega_a_execucao', async () => {
    const repo = gitFixture()
    const run = runDouble()
    const s = await serve([repo], { intent: planIntent().intent, runMission: run.runMission })
    await s.call('POST', `${s.base()}/options`, VALID)
    const { body: { mission_id: missionId } } = await s.call('POST', `${s.base()}/requests`, { text: 'Corrija o título' })
    const { digest } = (await s.call('GET', `${s.base()}/intake`)).body
    expect((await s.call('POST', `${s.base()}/intake/plan/approve`, { digest })).status).toBe(200)

    const missionDir = path.join(repo, '.ade', 'missions', missionId)
    expect(run.calls).toEqual([{ repoDir: path.resolve(repo), missionId, planPath: path.join(missionDir, 'plan.json'), options: VALID }])
    const fixed = path.join(missionDir, 'mission-options.json')
    expect(JSON.parse(fs.readFileSync(fixed, 'utf8'))).toEqual(VALID)

    expect((await s.call('POST', `${s.base()}/options`, { ...VALID, autonomy: 'safe', ceilings: { max_turns: 99, max_rounds: 9, usd_informative: null } })).status).toBe(200)
    expect(JSON.parse(fs.readFileSync(fixed, 'utf8'))).toEqual(VALID)
    run.finishAll()
    await expect.poll(() => s.server.projects.hasActivity(s.ids[0])).toBe(false)
  })

  test('criterio_12_autonomia_mais_alta_nao_aprova_plano_pendente', async () => {
    const run = runDouble()
    const s = await serve([gitFixture()], { intent: planIntent().intent, runMission: run.runMission })
    expect((await s.call('POST', `${s.base()}/options`, { ...VALID, autonomy: 'restricted', fast_lane: true })).status).toBe(200)
    expect((await s.call('POST', `${s.base()}/requests`, { text: 'Corrija o título' })).status).toBe(202)
    await new Promise((r) => setTimeout(r, 100))
    expect((await s.call('GET', `${s.base()}/intake`)).body.stage).toBe('plan')
    expect(run.calls).toHaveLength(0)
  })
})

// ---- motor: tetos da missão ao lado do plano ----

const NOW = Date.parse('2026-09-20T00:00:00.000Z')
const RECEIPT = {
  source: 'official',
  family: 'claude',
  used_percent: 20,
  reserved_percent: 10,
  observed_at: '2026-09-20T00:00:00.000Z',
  weekly_reset_at: '2026-09-27T00:00:00.000Z',
}

type Reply = { result: Record<string, unknown>; changes: boolean }

/** Motor com maker dublê roteirizado e, opcionalmente, mission-options.json na pasta do plano. */
function engineFixture(replies: Reply[], opts: { missionOptions?: unknown; makerLadder?: unknown[]; redGate?: boolean } = {}) {
  const repo = makeRepo()
  cleanups.push(() => removeTmpDir(repo.dir))
  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-options')
  fs.mkdirSync(missionDir, { recursive: true })
  if (opts.missionOptions) fs.writeFileSync(path.join(missionDir, 'mission-options.json'), JSON.stringify(opts.missionOptions))
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  cleanups.push(() => journal.close())
  let tree = 0
  const dispatched = vi.fn().mockImplementation(async () => {
    const reply = replies.shift()
    if (!reply) throw new Error('maker chamado além do roteiro')
    if (reply.changes) tree++
    return reply.result
  })
  const story = {
    id: 'ADE-O1',
    spec_revision: 'r1',
    evals: [],
    contract: {
      roles: { maker: { family: 'claude', model_id: 'sonnet' } },
      budget: { max_model_calls: 4, max_usd: 25 },
      guardrails: { scope_paths: [], do_not_touch: [] },
    },
  }
  const loaded = {
    plan: { id: 'plan-options', mission_id: 'mission-options', budget: { max_model_calls: 10 } },
    planDir: missionDir,
    missionBudget: { max_usd: 300, max_model_calls: 10, max_wall_clock_seconds: 28800, max_parked_units: 3 },
    gates: [],
  }
  const deps: any = {
    journal,
    quotaPort: { readReceipt: vi.fn().mockResolvedValue(RECEIPT) },
    step: async (spec: any, effect: any) => ({ step_id: spec.id, status: 'ok', result: await effect(), reused: false }),
    gitPortFor: () => ({ worktreeTree: async () => `tree${tree}` }),
    prepareStory: vi.fn().mockResolvedValue({ status: 'ready', worktreeDir: repo.dir }),
    createEvalRunner: () => ({ runEval: async () => ({ verdict: 'green' }) }),
    // portão dublê que sempre reprova: toda rodada volta rejeitada
    createGateRunner: () => ({
      runGates: async () => opts.redGate
        ? { ok: false, results: [{ gate_id: 'test', status: 'failure', exit_code: 1, argv: ['vitest'], raw_ref: 'r', reused: false, chargeable_reds: ['tests/a.test.ts > nova'] }] }
        : { ok: true, results: [] },
    }),
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: { bytes: 1 } }),
    contain: async () => ({ ok: true, changedPaths: tree > 0 ? ['src/work.txt'] : [] }),
    plantCanary: async () => ({}),
    checkCanary: async () => ({ escaped: false }),
    dispatchClaude: dispatched,
    resolved: { exe: process.execPath, prefixArgs: [] },
    workerEnv: {},
    capabilities: { probe_ok: true },
    env: { CI: 'true' },
    now: () => NOW,
    preflight: async () => ({ ready: true, failures: [], checks: [], calls_avoided: 0 }),
    makerLadder: opts.makerLadder,
  }
  const run = () => runStory(deps, { loaded: loaded as any, story, repoDir: repo.dir, missionDir })
  const events = () => readJournal(path.join(missionDir, 'journal.jsonl')).events
  return { run, dispatched, events }
}

const CUT = { result: { subtype: 'error_max_turns', num_turns: 12, total_cost_usd: 3 }, changes: true }
const NO_CHANGE = { result: { subtype: 'success', num_turns: 3, total_cost_usd: 3 }, changes: false }
const CHANGED = { result: { subtype: 'success', num_turns: 5, total_cost_usd: 3 }, changes: true }
const TWO_RUNGS = [{ model: 'sonnet', family: 'claude' }, { model: 'opus', family: 'claude' }]
const withCeilings = (ceilings: Partial<typeof VALID.ceilings>) => ({ ...VALID, ceilings: { max_turns: null, max_rounds: null, usd_informative: null, ...ceilings } })

describe('motor aplica os tetos de mission-options.json', () => {
  test('criterio_8_max_turns_12_limita_a_chamada_inicial_e_a_repeticao_depois_do_corte', async () => {
    const subject = engineFixture([CUT, CUT, NO_CHANGE], { missionOptions: withCeilings({ max_turns: 12 }) })
    const result = await subject.run()
    const turns = subject.dispatched.mock.calls.map((call) => call[0].maxTurns)
    expect(turns).toEqual([12, 12, 12])
    expect(Math.max(...turns)).toBeLessThanOrEqual(12)
    expect(result).toMatchObject({ status: 'awaiting_operator' })
  }, 30000)

  test('criterio_9_max_rounds_2_estaciona_depois_da_segunda_rodada_reprovada_somando_degraus', async () => {
    const subject = engineFixture([CHANGED, CHANGED, CHANGED, CHANGED], { missionOptions: withCeilings({ max_rounds: 2 }), makerLadder: TWO_RUNGS, redGate: true })
    const result = await subject.run()
    expect(subject.dispatched).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'gate_failed' })
    const ladder = subject.events().filter((e: any) => e.kind === 'decision' && e.data.decision === 'maker_ladder')
    expect(ladder.at(-1)?.data).toMatchObject({ next: 'park' })
  }, 30000)

  test('criterio_9b_max_rounds_1_estaciona_ja_na_primeira_rodada', async () => {
    const subject = engineFixture([CHANGED, CHANGED], { missionOptions: withCeilings({ max_rounds: 1 }), makerLadder: TWO_RUNGS, redGate: true })
    await subject.run()
    expect(subject.dispatched).toHaveBeenCalledTimes(1)
  }, 30000)

  test('criterio_10_usd_informativo_abaixo_do_custo_nao_bloqueia_a_execucao', async () => {
    const withUsd = engineFixture([CHANGED, CHANGED, CHANGED, CHANGED], { missionOptions: withCeilings({ usd_informative: 0.01, max_turns: 12 }), makerLadder: TWO_RUNGS, redGate: true })
    const without = engineFixture([CHANGED, CHANGED, CHANGED, CHANGED], { makerLadder: TWO_RUNGS, redGate: true })
    const a = await withUsd.run()
    const b = await without.run()
    expect(withUsd.dispatched.mock.calls.map((c) => c[0].model)).toEqual(['sonnet', 'sonnet', 'opus', 'opus'])
    expect(withUsd.dispatched.mock.calls.map((c) => c[0].model)).toEqual(without.dispatched.mock.calls.map((c) => c[0].model))
    expect(a).toEqual(b)
    // o arquivo foi lido (o teto de turnos vale), mas o dólar abaixo do custo não parou nada
    expect(withUsd.dispatched.mock.calls.map((c) => c[0].maxTurns)).toEqual([12, 12, 12, 12])
  }, 60000)

  test('criterio_10b_mission_options_invalido_ao_lado_do_plano_para_o_motor', async () => {
    const subject = engineFixture([CHANGED], { missionOptions: { ...VALID, autonomy: 'total' } })
    await expect(subject.run()).rejects.toMatchObject({ code: 'opcoes_invalidas' })
    expect(subject.dispatched).not.toHaveBeenCalled()
  }, 30000)

  test('criterio_11_sem_mission_options_o_motor_segue_como_hoje', async () => {
    const subject = engineFixture([CUT, NO_CHANGE])
    await subject.run()
    expect(subject.dispatched.mock.calls.map((call) => call[0].maxTurns)).toEqual([30, 60])
  }, 30000)
})

describe('páginas Opções e Skills no navegador', () => {
  test('criterio_13_no_navegador_opcoes_salvas_voltam_depois_de_recarregar_com_rotulos', async () => {
    const repo = gitFixture()
    const panel = await startPanelForTest({ repoDirs: [repo], deps: { catalogDir: catalogFixture() } })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByRole('button', { name: 'Opções' }).click()
    await page.getByRole('heading', { name: 'Opções' }).waitFor()
    await page.getByText(/só informativo/i).first().waitFor()
    await page.getByRole('radio', { name: /controlled/ }).click()
    await page.getByLabel('Teto de turnos por chamada').fill('12')
    await page.getByLabel('Teto de rodadas por parte').fill('2')
    await page.getByLabel('Valor em dólar (só informativo)').fill('0.5')
    await page.getByRole('switch', { name: 'Pesquisa na internet' }).click()
    await page.getByRole('button', { name: 'Salvar opções' }).click()
    await page.getByText('Opções salvas.').waitFor()
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(repo, '.ade', 'options.json'), 'utf8')).ceilings.max_turns).toBe(12)

    await page.reload()
    await page.getByRole('button', { name: 'Opções' }).click()
    await page.getByRole('heading', { name: 'Opções' }).waitFor()
    await expect.poll(() => page.getByLabel('Teto de turnos por chamada').inputValue()).toBe('12')
    expect(await page.getByLabel('Teto de rodadas por parte').inputValue()).toBe('2')
    expect(await page.getByLabel('Valor em dólar (só informativo)').inputValue()).toBe('0.5')
    expect(await page.getByRole('radio', { name: /controlled/ }).getAttribute('aria-checked')).toBe('true')
    expect(await page.getByRole('switch', { name: 'Pesquisa na internet' }).getAttribute('aria-checked')).toBe('true')
    for (const name of ['Faixa rápida', 'Portão visual', 'Imagens geradas por IA', 'Pesquisa na internet']) {
      expect(await page.getByRole('switch', { name }).count(), name).toBe(1)
    }
    // Todo controle da página tem nome acessível.
    const unnamed = await page.locator('form[aria-label="Opções da missão"]').evaluate((form) =>
      [...form.querySelectorAll('input, button, [role=switch], [role=radio]')]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true' && (el as HTMLElement).offsetParent !== null)
        .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el as HTMLInputElement).labels?.length || el.textContent?.trim()))
        .map((el) => el.outerHTML.slice(0, 80)))
    expect(unnamed).toEqual([])
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)

  test('criterio_14_no_navegador_busca_abre_skill_e_desliga_plugin', async () => {
    const panel = await startPanelForTest({ repoDirs: [gitFixture()], deps: { catalogDir: catalogFixture() } })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui

    await page.getByRole('button', { name: 'Skills' }).click()
    await page.getByRole('heading', { name: 'Skills' }).waitFor()
    await page.getByLabel('Buscar skill').fill('tdd')
    await expect.poll(() => page.getByRole('button', { name: 'Abrir react-ui' }).count()).toBe(0)
    await page.getByRole('button', { name: 'Abrir tdd' }).click()
    await page.getByText('Corpo da skill tdd: escreva a prova primeiro.').waitFor()

    await page.getByRole('switch', { name: 'Plugin acme' }).click()
    await page.getByText('desligada neste projeto').first().waitFor()
    await page.getByLabel('Buscar skill').fill('')
    await expect.poll(() => page.getByText('desligada neste projeto').count()).toBe(2)
    expect(await page.getByRole('switch', { name: 'Plugin acme' }).getAttribute('aria-checked')).toBe('false')
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)
})
