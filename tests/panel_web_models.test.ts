import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createLocalQuotaPort } from '../src/adapters/local/quota.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { openJournal } from '../src/journal/journal.ts'
import { buildRuntimeStamp } from '../src/journal/stamp.ts'
import { startServer } from '../src/panel/server.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, freePort, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

// relógio fixo: nada aqui vence com o tempo
const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const AT = '2026-09-23T10:00:00.000Z'
const MODEL = { claude: 'claude-opus-5-5', codex: 'gpt-6-sol', agy: 'gemini-3.8-flash-high' } as const
type Fam = keyof typeof MODEL

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

let seq = 0
function call(unit: string, family: Fam, role: 'maker' | 'checker_round', usd: number, durationMs: number) {
  seq++
  return {
    kind: 'telemetry',
    unit,
    data: buildModelTelemetry({
      mission_id: 'm1', story_id: unit, step_id: `${unit}:${seq}:${role}`, family, role, effort: 'high',
      models: [{ role: 'executor', model_id: MODEL[family] }], duration_ms: durationMs,
      tokens: { source: 'reported', input: 1, output: 1, cache_read: 0, cache_write: 0, usd }, usage: undefined,
      pack: { sections: [{ section: 'contract', bytes: 10, digest: '1111111111111111' }], bytes: 10 },
      skills: [], sources: [], outcome: 'ok', ttft_ms: null, approval_decisions: 0, network_attempts: 0,
      files_touched: 1, tool_output_raw_bytes: 0, tool_output_model_bytes: 0,
    }),
  }
}
const review = (unit: string) => ({ kind: 'review_result', unit, data: { round: 1, approved: true } })
const done = (unit: string, added: number, removed: number) => ({
  kind: 'story_done', unit, data: { unit, status: 'committed', commit: 'c0ffee', measure: { rounds: 1, lines_added: added, lines_removed: removed } },
})

async function writeJournal(repoDir: string, events: Array<Record<string, any>>) {
  const journal = openJournal({
    missionDir: path.join(repoDir, '.ade', 'missions', 'm1'),
    runtimeStamp: buildRuntimeStamp({ configDigest: digest16({}), capabilitiesDigest: digest16({}) }),
    now: () => new Date(AT),
  })
  for (const e of events) await journal.append(e)
  await journal.close()
}

function repoFixture(models?: Record<string, unknown>) {
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'README.md'), '# fixture\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  if (models) {
    mkdirSync(path.join(repo.dir, '.ade'), { recursive: true })
    writeFileSync(path.join(repo.dir, '.ade', 'config.json'), JSON.stringify({ models }, null, 2))
  }
  cleanups.push(() => removeTmpDir(repo.dir))
  return repo
}

/** Recibo oficial do Claude, lido pela porta local da real apontada para um arquivo de fixture. */
function quotaPortFixture() {
  const dir = makeTmpDir('ade-quota-')
  cleanups.push(() => removeTmpDir(dir))
  const receiptPath = path.join(dir, 'quota-receipt.json')
  writeFileSync(receiptPath, JSON.stringify({
    source: 'official', family: 'claude', used_percent: 62,
    observed_at: '2026-09-23T11:00:00.000Z', weekly_reset_at: '2026-09-27T09:00:00.000Z',
  }))
  return createLocalQuotaPort({ receiptPath })
}

const PLANS = { plans: { claude: 'max20', codex: 'pro20' } }

/** Claude escreve e entrega 400 linhas; Codex revisa. */
const claudeJournal = [
  call('P1', 'claude', 'maker', 2, 120_000), call('P1', 'codex', 'checker_round', 0.5, 60_000), review('P1'), done('P1', 300, 100),
]
/** Codex escreve e entrega 200 linhas. */
const codexJournal = [call('P2', 'codex', 'maker', 1, 180_000), call('P2', 'codex', 'maker', 1, 60_000), review('P2'), done('P2', 150, 50)]

async function serve(repoDirs: string[]) {
  const homeDir = makeTmpDir('ade-models-home-')
  const server = await startServer({
    repoDir: repoDirs[0], port: await freePort(), openBrowser: false,
    deps: { stdout: () => {}, homeDir, quotaPort: quotaPortFixture(), now: () => NOW },
  })
  for (const dir of repoDirs.slice(1)) await server.projects.open(dir)
  cleanups.push(async () => {
    await server.close()
    removeTmpDir(homeDir)
  })
  const call = async (p: string, body?: unknown) => {
    const res = await apiRequest(server.port, p, { token: server.sessionToken, method: body === undefined ? 'GET' : 'POST', body })
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  return { server, call, ids: server.projects.list().map((p) => p.id) }
}

type Slot = { model_id: string; family: string; effort: string; reserve?: boolean; why: { capacity: number; quality: number; intelligence: number; cost: number; note: string } }
const allSlots = (chains: Record<string, Slot[]>) => Object.values(chains).flat()

describe('painel: página Modelos com filas, cota e uso', () => {
  test('criterio_1_get_models_traz_catalogo_planos_bloqueados_e_filas_com_o_porque', async () => {
    const repo = repoFixture({ ...PLANS, blocked: ['gpt-6-luna'] })
    const s = await serve([repo.dir])
    const res = await s.call('/api/models')
    expect(res.status).toBe(200)
    expect(res.body.catalog.some((e: any) => e.model === 'claude-opus-5-5')).toBe(true)
    expect(Object.keys(res.body.plans)).toEqual(['claude', 'codex', 'agy'])
    expect(res.body.settings.plans).toEqual({ claude: 'max20', codex: 'pro20' })
    expect(res.body.blocked).toEqual(['gpt-6-luna'])
    expect(res.body.quota.claude).toEqual({ used: 62, resets_at: '2026-09-27T09:00:00.000Z', source: 'official' })
    expect(res.body.quota.codex.source).toBe('plano')
    for (const role of ['epics', 'plan', 'plan_edit', 'test', 'impl_light', 'impl', 'impl_hard', 'fix', 'checker']) {
      expect(res.body.chains[role].length).toBeGreaterThan(0)
    }
    const first: Slot = res.body.chains.impl[0]
    expect(typeof first.why.capacity).toBe('number')
    expect(typeof first.why.quality).toBe('number')
    expect(typeof first.why.intelligence).toBe('number')
    expect(typeof first.why.cost).toBe('number')
    expect(first.why.note).toMatch(/nota .*inteligência/)
  })

  test('criterio_2_quem_escreve_e_quem_revisa_sao_de_empresas_diferentes_e_escada_termina_em_reserva_de_outra', async () => {
    const repo = repoFixture(PLANS)
    const s = await serve([repo.dir])
    const { chains } = (await s.call('/api/models')).body
    expect(chains.checker[0].family).not.toBe(chains.impl[0].family)
    const last = chains.fix.at(-1)
    expect(last.reserve).toBe(true)
    expect(last.family).not.toBe(chains.fix[0].family)
  })

  test('criterio_3_modelo_bloqueado_some_de_todas_as_filas', async () => {
    const repo = repoFixture(PLANS)
    const s = await serve([repo.dir])
    const before = (await s.call('/api/models')).body.chains
    const target = before.impl[0].model_id
    const res = await s.call('/api/models/settings', { blocked: [target] })
    expect(res.status).toBe(200)
    expect(res.body.blocked).toEqual([target])
    const after = (await s.call('/api/models')).body
    expect(after.blocked).toEqual([target])
    expect(allSlots(after.chains).some((x) => x.model_id === target)).toBe(false)
  })

  test('criterio_4_empresa_plano_modelo_ou_esforco_invalido_responde_400_e_nao_grava', async () => {
    const repo = repoFixture(PLANS)
    const s = await serve([repo.dir])
    const config = path.join(repo.dir, '.ade', 'config.json')
    const before = readFileSync(config, 'utf8')
    for (const body of [
      { plans: { microsoft: 'pro' } },
      { plans: { claude: 'ultra' } },
      { blocked: ['gpt-99'] },
      { blocked: 'claude-opus-5-5' },
      { efforts: { impl: 'turbo' } },
      { efforts: { chefe: 'high' } },
      { plans: { claude: 'max5' }, efforts: { impl: 'turbo' } },
    ]) {
      const res = await s.call('/api/models/settings', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(readFileSync(config, 'utf8')).toBe(before)
  })

  test('criterio_5_cota_manual_do_google_vira_origem_manual_e_pesa_nas_filas_fora_da_faixa_400', async () => {
    const repo = repoFixture({ plans: { agy: 'ultra1000' } })
    const s = await serve([repo.dir])
    const before = (await s.call('/api/models')).body
    expect(before.quota.agy.source).toBe('plano')
    const capBefore = before.chains.impl[0].why.capacity
    const res = await s.call('/api/models/quota', { family: 'agy', used: 90, resets_at: '2026-09-24T12:00:00.000Z' })
    expect(res.status).toBe(200)
    const after = (await s.call('/api/models')).body
    expect(after.quota.agy).toEqual({ used: 90, resets_at: '2026-09-24T12:00:00.000Z', source: 'manual' })
    expect(after.chains.impl[0].family).toBe('agy')
    // 90% gastos com 6 de 7 dias passados: projeta 105% na renovação
    expect(after.chains.impl[0].why.capacity).toBe(105)
    expect(after.chains.impl[0].why.capacity).toBeGreaterThan(capBefore)
    for (const body of [
      { family: 'agy', used: 101, resets_at: '2026-09-24T12:00:00.000Z' },
      { family: 'agy', used: -1, resets_at: '2026-09-24T12:00:00.000Z' },
      { family: 'agy', used: 50, resets_at: 'amanhã' },
      { family: 'agy', used: 50, resets_at: '2026-09-22T12:00:00.000Z' },
      { family: 'google', used: 50, resets_at: '2026-09-24T12:00:00.000Z' },
    ]) {
      expect((await s.call('/api/models/quota', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await s.call('/api/models')).body.quota.agy.used).toBe(90)
  })

  test('criterio_6_uso_por_empresa_do_journal_do_projeto_ativo_com_dolar_informativo', async () => {
    const repo = repoFixture(PLANS)
    await writeJournal(repo.dir, claudeJournal)
    const s = await serve([repo.dir])
    const res = await s.call('/api/usage?since=2026-09-20')
    expect(res.status).toBe(200)
    expect(res.body.project_id).toBe(s.ids[0])
    expect(res.body.usd_informative).toBe(true)
    const claude = res.body.companies.find((c: any) => c.family === 'claude')
    const codex = res.body.companies.find((c: any) => c.family === 'codex')
    expect(claude).toMatchObject({ quota: { used: 62, source: 'official' }, calls: 1, approved_stories: 1, approved_lines: 400, usd: 2, usd_per_1000_lines: 5, minutes_per_call: 2 })
    expect(codex).toMatchObject({ calls: 1, approved_lines: 0, usd: 0.5, minutes_per_call: 1 })
    expect(codex.quota.used).toEqual(expect.any(Number))
    // since depois das chamadas: nada entra
    const later = (await s.call('/api/usage?since=2026-09-24')).body
    expect(later.companies.every((c: any) => c.calls === 0)).toBe(true)
    expect((await s.call('/api/usage?since=23-09-2026')).status).toBe(400)
  })

  test('criterio_7_trocar_o_projeto_ativo_troca_o_relatorio_de_uso', async () => {
    const a = repoFixture()
    const b = repoFixture()
    await writeJournal(a.dir, claudeJournal.slice(0, 1))
    await writeJournal(b.dir, codexJournal)
    const s = await serve([a.dir, b.dir])
    const first = (await s.call('/api/usage')).body
    expect(first.project_id).toBe(s.ids[0])
    expect(first.companies.map((c: any) => c.family)).toEqual(['claude'])
    expect((await s.call('/api/projects/select', { id: s.ids[1] })).status).toBe(200)
    const second = (await s.call('/api/usage')).body
    expect(second.project_id).toBe(s.ids[1])
    // o recibo oficial do Claude é da conta, não do projeto: a linha fica, mas sem chamadas
    expect(second.companies.filter((c: any) => c.calls > 0)).toEqual([expect.objectContaining({ family: 'codex', calls: 2, approved_lines: 200 })])
  })

  async function ui(repoDirs: string[]) {
    const panel = await startPanelForTest({ repoDirs, deps: { quotaPort: quotaPortFixture(), now: () => NOW } })
    cleanups.push(panel.close)
    const opened = await openPanel(panel.url)
    cleanups.push(() => opened.browser.close())
    await opened.page.getByRole('button', { name: 'Modelos' }).click()
    return { ...opened, panel }
  }

  test('criterio_8_no_navegador_modelos_mostra_filas_com_porque_cota_com_renovacao_e_uso', async () => {
    const repo = repoFixture(PLANS)
    await writeJournal(repo.dir, claudeJournal)
    const { page, consoleErrors } = await ui([repo.dir])
    const queues = page.getByRole('region', { name: 'Filas por papel' })
    await expect.poll(() => queues.getByText('revisar').count()).toBeGreaterThan(0)
    await expect.poll(() => queues.textContent()).toMatch(/capacidade \d+%.*qualidade.*inteligência.*custo/)
    const quota = page.getByRole('region', { name: 'Cota da semana' })
    await expect.poll(() => quota.getByRole('progressbar').count()).toBe(2)
    await expect.poll(() => quota.getByTestId('quota-claude').textContent()).toMatch(/62%.*oficial.*renova/)
    const usage = page.getByRole('region', { name: 'Uso por empresa' })
    await expect.poll(() => usage.getByTestId('usage-claude').textContent()).toMatch(/400/)
    await expect.poll(() => usage.textContent()).toMatch(/informativo/)
    expect(consoleErrors).toEqual([])
  }, 180_000)

  test('criterio_9_no_navegador_trocar_o_projeto_ativo_troca_o_uso_na_tela', async () => {
    const a = repoFixture()
    const b = repoFixture()
    await writeJournal(a.dir, claudeJournal.slice(0, 1))
    await writeJournal(b.dir, codexJournal)
    const { page, panel } = await ui([a.dir, b.dir])
    const usage = page.getByRole('region', { name: 'Uso por empresa' })
    await expect.poll(() => usage.getByTestId('usage-claude').textContent()).toMatch(/1 chamada/)
    expect(await usage.getByTestId('usage-codex').count()).toBe(0)
    const nameB = panel.server.projects.list()[1].name
    await page.getByRole('button', { name: `Usar ${nameB}` }).click()
    await expect.poll(() => usage.getByTestId('usage-codex').textContent()).toMatch(/2 chamadas/)
    await expect.poll(() => usage.getByTestId('usage-claude').textContent()).toMatch(/0 chamadas/)
    await expect.poll(() => usage.textContent()).toContain(panel.server.projects.list()[1].id)
  }, 180_000)

  test('criterio_10_no_navegador_bloquear_modelo_some_das_filas_sem_recarregar', async () => {
    const repo = repoFixture(PLANS)
    const { page } = await ui([repo.dir])
    const queues = page.getByRole('region', { name: 'Filas por papel' })
    await expect.poll(() => queues.getByTestId('slot-claude-opus-5-5').count()).toBeGreaterThan(0)
    await page.evaluate(() => { (window as unknown as { marca: number }).marca = 1 })
    await queues.getByRole('button', { name: 'Bloquear claude-opus-5-5' }).first().click()
    await expect.poll(() => queues.getByTestId('slot-claude-opus-5-5').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { marca?: number }).marca)).toBe(1)
    await expect.poll(() => page.getByRole('region', { name: 'Modelos bloqueados' }).textContent()).toContain('claude-opus-5-5')
  }, 180_000)

  test('abrir_modelos_rele_a_cota_dos_planos_em_segundo_plano_no_maximo_a_cada_10_minutos', async () => {
    let clock = NOW
    let reads = 0
    const homeDir = makeTmpDir('ade-models-home-')
    const server = await startServer({
      repoDir: repoFixture(PLANS).dir, port: await freePort(), openBrowser: false,
      deps: { stdout: () => {}, homeDir, quotaPort: quotaPortFixture(), now: () => clock, refreshQuota: async () => { reads++ } },
    })
    cleanups.push(async () => { await server.close(); removeTmpDir(homeDir) })
    const get = () => apiRequest(server.port, '/api/models', { token: server.sessionToken })
    expect((await get()).status).toBe(200)
    await get()
    expect(reads).toBe(1)
    clock += 11 * 60_000
    await get()
    expect(reads).toBe(2)
  }, 180_000)
})
