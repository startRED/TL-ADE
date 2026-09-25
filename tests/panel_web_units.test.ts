import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { compileIntent } from '../src/intent/compiler.ts'
import { openJournal } from '../src/journal/journal.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

const STAMP = '1:abc123:def456'
const MISSION = 'M-units'

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

const DISCOVERY = {
  repo: { head: 'HEAD', dirty: false },
  scripts: { test: 'node --test' },
  languages: [{ name: 'javascript', share: 1 }],
  anchors: [],
  ui: { present: false },
}

/** Contrato válido do compilador da real, clonado para as duas partes da fixture. */
async function contractTemplate() {
  const advisor = async () => ({ complexity: 'bounded', confidence: 0.9, domains: ['backend'], rationale: 'dublê', cost: { usd: 0, model_calls: 1, model_id: 'dublê' } })
  const { plan, contracts } = await compileIntent({ request: 'Cadastrar compromissos numa agenda.', discovery: DISCOVERY, advisor, unknowns: [] })
  return { plan, contract: contracts[0] }
}

/**
 * Repositório com commit-base e commit da parte U1, mudanças soltas no índice e na árvore de trabalho,
 * e uma missão de duas partes (U1 revisada e entregue, U2 em andamento) no journal da real.
 */
async function fixture() {
  const repo = makeRepo()
  cleanups.push(() => removeTmpDir(repo.dir))
  const app = path.join(repo.dir, 'app.js')
  writeFileSync(app, 'const a = 1\nconst b = 2\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'base'])
  const base = repo.git(['rev-parse', 'HEAD']).trim()
  writeFileSync(app, 'const a = 1\nconst c = 3\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'ade(U1): parte'])
  const head = repo.git(['rev-parse', 'HEAD']).trim()
  // Fora do commit: arquivo no índice e linha só na árvore de trabalho.
  writeFileSync(path.join(repo.dir, 'staged.txt'), 'no indice\n')
  repo.git(['add', 'staged.txt'])
  writeFileSync(app, 'const a = 1\nconst c = 3\nconst sujo = 4\n')

  const missionDir = path.join(repo.dir, '.ade', 'missions', MISSION)
  mkdirSync(path.join(missionDir, 'stories'), { recursive: true })
  const { plan, contract } = await contractTemplate()
  writeFileSync(path.join(missionDir, 'plan.json'), JSON.stringify({ ...plan, mission_id: MISSION, phases: [{ epics: [{ stories: ['U1', 'U2'] }] }] }))
  writeFileSync(path.join(missionDir, 'stories', 'U1.json'), JSON.stringify({ ...contract, id: 'U1', title: 'Cadastro de compromissos' }))
  writeFileSync(path.join(missionDir, 'stories', 'U2.json'), JSON.stringify({ ...contract, id: 'U2', title: 'Lista da semana' }))

  const journal = openJournal({ missionDir, runtimeStamp: STAMP })
  const step = async (unit: string, id: string, effectClass: string, result?: { status: string; result?: unknown }) => {
    await journal.append({ kind: 'step_intent', step_id: id, effect_class: effectClass, unit })
    if (result) await journal.append({ kind: 'step_result', step_id: id, effect_class: effectClass, ...result })
  }
  await journal.append({ kind: 'story_started', unit: 'U1', data: { unit: 'U1', base_before: base } })
  await step('U1', 'U1:r1:maker', 'model_call', { status: 'ok' })
  await step('U1', 'eval:E1:red:t0', 'eval_run', { status: 'ok', result: { eval_id: 'E1', phase: 'red', verdict: 'red_valid' } })
  await step('U1', 'eval:E1:green:t1', 'eval_run', { status: 'ok', result: { eval_id: 'E1', phase: 'green', verdict: 'green' } })
  await step('U1', 'eval:E2:green:t1', 'eval_run', { status: 'ok', result: { eval_id: 'E2', phase: 'green', verdict: 'red' } })
  await journal.append({ kind: 'gates_done', unit: 'U1', data: { results: [{ gate_id: 'test', status: 'failure', chargeable_reds: ['tests/app.test.js > soma'] }] } })
  await journal.append({ kind: 'telemetry', unit: 'U1', data: { role: 'prova', family: 'agy', story_id: 'U1', models: [{ role: 'executor', model_id: 'gemini-3.8-flash' }], skills_injected: [{ name: 'test-driven-development' }] } })
  await journal.append({ kind: 'telemetry', unit: 'U1', data: { role: 'maker', family: 'claude', story_id: 'U1', models: [{ role: 'executor', model_id: 'claude-opus-5-5' }], skills_injected: [{ name: 'ponytail' }, { name: 'test-driven-development' }] } })
  await journal.append({ kind: 'telemetry', unit: 'U1', data: { role: 'checker_round', story_id: 'U1', models: [{ role: 'executor', model_id: 'gpt-5.5' }] } })
  await journal.append({
    kind: 'review_result',
    unit: 'U1',
    data: {
      round: 1,
      approved: false,
      verdict: 'changes_requested',
      result: {
        verdict: 'changes_requested',
        action_items: [
          { id: 'F1', severity: 'high', problem: 'Falta validar a data.' },
          { id: 'F2', severity: 'medium', problem: 'Nome confuso.', withdrawn: true, citation: 'file:app.js#L1-L1', withdrawn_reason: 'o nome segue o contrato' },
        ],
      },
    },
  })
  await journal.append({
    kind: 'review_result',
    unit: 'U1',
    data: { round: 2, approved: true, verdict: 'approved', result: { verdict: 'approved', action_items: [{ id: 'F3', severity: 'low', problem: 'Comentário sobrando.' }] } },
  })
  await journal.append({ kind: 'story_done', unit: 'U1', data: { unit: 'U1', status: 'delivered', commit: head } })
  await journal.append({ kind: 'story_started', unit: 'U2', data: { unit: 'U2', base_before: head } })
  await step('U2', 'eval:E1:red:t2', 'eval_run', { status: 'ok', result: { eval_id: 'E1', phase: 'red', verdict: 'downgraded_additive' } })
  await step('U2', 'U2:r1:maker', 'model_call')
  await journal.close()
  return { repoDir: repo.dir, missionDir, base, head }
}

async function serveFixture() {
  const fx = await fixture()
  const panel = await startPanelForTest({ repoDirs: [fx.repoDir] })
  cleanups.push(panel.close)
  const projectId = panel.server.projects.list()[0].id
  const get = async (p: string) => {
    const res = await apiRequest(panel.server.port, p, { token: panel.token })
    return { status: res.status, body: JSON.parse(res.body) }
  }
  const units = `/api/projects/${encodeURIComponent(projectId)}/missions/${MISSION}/units`
  return { ...fx, panel, projectId, get, units }
}

describe('painel: partes com passos, diff, provas e parecer', () => {
  test('C1 lista as partes com id, título, estado, rodadas e passos na ordem do journal', async () => {
    const { get, units } = await serveFixture()
    const res = await get(units)
    expect(res.status).toBe(200)
    expect(res.body.map((u: any) => [u.id, u.title, u.state, u.rounds])).toEqual([
      ['U1', 'Cadastro de compromissos', 'delivered', 2],
      ['U2', 'Lista da semana', 'in_progress', 0],
    ])
    expect(res.body[0].steps.map((s: any) => [s.name, s.state])).toEqual([
      ['U1:r1:maker', 'ok'],
      ['eval:E1:red:t0', 'ok'],
      ['eval:E1:green:t1', 'ok'],
      ['eval:E2:green:t1', 'ok'],
    ])
    // vermelho que não falhou sai como tal, não como passo ok (missão real de anexos, 25/09)
    expect(res.body[1].steps.map((s: any) => [s.name, s.state])).toEqual([['eval:E1:red:t2', 'red_not_red'], ['U2:r1:maker', 'running']])
    expect(res.body[1].steps[1].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  }, 120_000)

  test('atividade_completa_em_frases_e_so_o_novo_depois_de_since', async () => {
    const { get, units } = await serveFixture()
    const log = units.replace(/units$/, 'log')
    const all = (await get(log)).body as Array<{ seq: number; unit: string | null; text: string }>
    expect(all.map((l) => l.text)).toContain('rodada 1: escrevendo o código…')
    expect(all.some((l) => l.unit === 'U2')).toBe(true)
    const last = all.at(-1)!.seq
    expect((await get(`${log}?since=${last}`)).body).toEqual([])
  }, 120_000)

  test('C2 o diff da parte é git diff do commit-base ao commit da parte', async () => {
    const { get, units, base, head } = await serveFixture()
    const res = await get(`${units}/U1`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('U1')
    expect(res.body.base_commit).toBe(base)
    expect(res.body.head_commit).toBe(head)
    expect(res.body.diff.map((f: any) => f.file)).toEqual(['app.js'])
    const lines = res.body.diff[0].lines
    expect(lines).toContainEqual({ kind: 'del', text: 'const b = 2' })
    expect(lines).toContainEqual({ kind: 'add', text: 'const c = 3' })
    expect(lines).toContainEqual({ kind: 'ctx', text: 'const a = 1' })
  }, 120_000)

  test('C3 mudanças do índice e da árvore de trabalho fora do commit não aparecem no diff', async () => {
    const { get, units } = await serveFixture()
    const res = await get(`${units}/U1`)
    const text = JSON.stringify(res.body.diff)
    expect(text).not.toContain('sujo')
    expect(text).not.toContain('staged.txt')
    // Parte sem commit ainda não tem diff.
    const open = await get(`${units}/U2`)
    expect(open.body.head_commit).toBeNull()
    expect(open.body.diff).toEqual([])
  }, 120_000)

  test('C4 provas vêm com nome e estado, e as vermelhas na largada separadas das cobradas', async () => {
    const { get, units } = await serveFixture()
    const { body } = await get(`${units}/U1`)
    expect(body.tests).toEqual([
      { name: 'E1', status: 'passed', baseline_red: false },
      { name: 'E2', status: 'failed', baseline_red: false },
      { name: 'tests/app.test.js > soma', status: 'failed', baseline_red: false },
      { name: 'E1', status: 'red_at_start', baseline_red: true },
    ])
  }, 120_000)

  test('C5 parecer traz veredito, modelo do revisor e achados com gravidade e estado', async () => {
    const { get, units } = await serveFixture()
    const { body } = await get(`${units}/U1`)
    expect(body.review).toEqual({
      verdict: 'approved',
      model_id: 'gpt-5.5',
      findings: [
        { id: 'F1', severity: 'high', text: 'Falta validar a data.', status: 'resolved', citation: null },
        { id: 'F2', severity: 'medium', text: 'Nome confuso.', status: 'withdrawn', citation: 'file:app.js#L1-L1' },
        { id: 'F3', severity: 'low', text: 'Comentário sobrando.', status: 'open', citation: null },
      ],
    })
    expect((await get(`${units}/U2`)).body.review).toBeNull()
    // 25/09: o painel não dizia quais skills a missão usou; cada papel aparece com o modelo e as skills do pacote dele
    expect(body.skills).toEqual([
      { role: 'prova', model_id: 'gemini-3.8-flash', family: 'agy', skills: ['test-driven-development'] },
      { role: 'código', model_id: 'claude-opus-5-5', family: 'claude', skills: ['ponytail', 'test-driven-development'] },
      { role: 'revisão', model_id: 'gpt-5.5', family: null, skills: [] },
    ])
  }, 120_000)

  test('C6 parte, missão ou id malformado inexistente responde 404', async () => {
    const { get, units, projectId } = await serveFixture()
    expect((await get(`${units}/U1`)).status).toBe(200)
    expect((await get(`${units}/U9`)).status).toBe(404)
    expect((await get(`/api/projects/${encodeURIComponent(projectId)}/missions/M-nada/units`)).status).toBe(404)
    expect((await get(`/api/projects/${encodeURIComponent(projectId)}/missions/M-nada/units/U1`)).status).toBe(404)
    expect((await get(`/api/projects/${encodeURIComponent(projectId)}/missions/%2E%2E/units`)).status).toBe(404)
    expect((await get(`/api/projects/p-nada/missions/${MISSION}/units`)).status).toBe(404)
  }, 120_000)

  test('C7 no chromium, abrir uma parte mostra passos, diff marcado, provas e parecer', async () => {
    const { panel } = await serveFixture()
    const { browser, page, consoleErrors } = await openPanel(panel.url)
    cleanups.push(() => browser.close())
    await page.getByRole('button', { name: /Cadastro de compromissos/ }).click()
    const detail = page.getByTestId('unit-detail')
    await detail.getByText('U1:r1:maker').waitFor()
    await expect(detail.locator('[data-kind="add"]').first().textContent()).resolves.toContain('const c = 3')
    await expect(detail.locator('[data-kind="del"]').first().textContent()).resolves.toContain('const b = 2')
    await detail.getByText('tests/app.test.js > soma').waitFor()
    await detail.getByText('Vermelhas na largada').waitFor()
    await detail.getByText('gpt-5.5').first().waitFor()
    await detail.getByText('Falta validar a data.').waitFor()
    await detail.getByText('ponytail, test-driven-development').waitFor()
    await detail.getByText(/Escreve o código/).waitFor()
    expect(consoleErrors).toEqual([])
  }, 180_000)

  test('C8 passo novo no journal aparece na parte aberta sem recarregar', async () => {
    const { panel, missionDir } = await serveFixture()
    const { browser, page, consoleErrors } = await openPanel(panel.url)
    cleanups.push(() => browser.close())
    await page.getByRole('button', { name: /Cadastro de compromissos/ }).click()
    const detail = page.getByTestId('unit-detail')
    await detail.getByText('U1:r1:maker').waitFor()
    const loads = await page.evaluate(() => performance.getEntriesByType('navigation').length)
    const journal = openJournal({ missionDir, runtimeStamp: STAMP })
    await journal.append({ kind: 'step_intent', step_id: 'U1:deliver:ao-vivo', effect_class: 'git', unit: 'U1' })
    await journal.close()
    await detail.getByText('U1:deliver:ao-vivo').waitFor({ timeout: 15_000 })
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(loads)
    expect(consoleErrors).toEqual([])
  }, 180_000)
})

