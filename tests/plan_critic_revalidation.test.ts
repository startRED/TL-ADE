import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { main as approveCli } from '../src/cli/approve.ts'
import { main as planCli } from '../src/cli/plan.ts'
import { approvalReasons, planStoriesDigest } from '../src/intent/proportional.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { AdeError } from '../src/journal/errors.ts'
import { readJournal } from '../src/journal/journal.ts'
import { approveMission, planMission } from '../src/mission/plan-lifecycle.ts'

const advisor = () =>
  vi.fn().mockResolvedValue({
    complexity: 'feature',
    confidence: 0.9,
    domains: ['backend'],
    rationale: 'dublê',
    cost: { usd: 0.01, model_calls: 1, model_id: 'claude-haiku-4-5' },
  })

const REQUEST = 'Adicionar filtro por data na listagem de pedidos'
const READY = { verdict: 'ready', summary: 'executável', issues: [] }
const REVISE = { verdict: 'revise', summary: 'falta intervalo', issues: [{ story: 'S1', problem: 'sem intervalo', fix: 'aceitar intervalo de datas' }] }

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p: string, data: unknown) => fs.writeFileSync(p, JSON.stringify(data, null, 2))
const critic = (family: string, critique: (input: any) => Promise<unknown>) => ({ family, model: `${family}-dublê`, critique: vi.fn(critique) })
const approvals = (missionDir: string) =>
  readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e) => e.kind === 'decision' && e.data?.decision === 'plan_approved')

describe('Crítica do plano revalidada após correção', () => {
  let repoDir: string
  const missionDirOf = (id: string) => path.join(repoDir, '.ade', 'missions', id)
  const planPathOf = (id: string) => path.join(missionDirOf(id), 'plan.json')
  const cli = async (main: typeof planCli, argv: string[], deps: any = {}) => {
    let out = ''
    let err = ''
    const code = await main(argv, { ...deps, stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) })
    return { code, out, err }
  }

  /** Plano de uma story com crítica 'ready' e, depois, uma story S2 enfiada à mão no plan.json. */
  async function staleMission() {
    const res = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [critic('codex', async () => READY)] })
    const dir = missionDirOf(res.missionId)
    const s1 = readJson(path.join(dir, 'stories', 'S1.json'))
    writeJson(path.join(dir, 'stories', 'S2.json'), { ...s1, id: 'S2', title: 'S2 exportar pedidos filtrados', task: 'exportar pedidos filtrados' })
    const plan = readJson(planPathOf(res.missionId))
    plan.phases[0].epics[0].stories.push('S2')
    writeJson(planPathOf(res.missionId), plan)
    return { missionId: res.missionId, plan }
  }

  /** Grava no plano um briefing de produto cuja versão atual tem os critérios do épico dados. */
  function withEpic(missionId: string, includes: string[]) {
    const plan = readJson(planPathOf(missionId))
    plan.briefing.version_index = 0
    plan.briefing.product = { title: 'Pedidos', versions: [{ name: 'v1', goal: 'filtrar', includes }] }
    writeJson(planPathOf(missionId), plan)
  }

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-critic-revalidation-'))
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }))
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('criterio_1_plano_corrigido_roda_a_critica_de_novo_e_grava_o_digest_das_stories_atuais', async () => {
    let calls = 0
    const codex = critic('codex', async () => (++calls === 1 ? REVISE : READY))
    const first = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [codex] })
    expect(readJson(first.planPath as string).briefing.plan_critic.verdict).toBe('revise')

    const fixed = await planMission(
      { request: `${REQUEST} com intervalo de datas`, repoDir, fromMissionId: first.missionId },
      { advisor: advisor(), planCritics: [codex] },
    )
    const plan = readJson(fixed.planPath as string)

    expect(codex.critique).toHaveBeenCalledTimes(2)
    expect(codex.critique.mock.calls[1][0].plan.mission_id).toBe(fixed.missionId)
    expect(plan.briefing.plan_critic).toMatchObject({ verdict: 'ready', family: 'codex', plan_digest: planStoriesDigest(plan) })
  })

  test('criterio_2_nova_critica_ready_nao_deixa_motivo_de_critica_e_o_plano_espera_ade_approve', async () => {
    let calls = 0
    const codex = critic('codex', async () => (++calls === 1 ? REVISE : READY))
    const first = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [codex] })
    const fixed = await planMission(
      { request: `${REQUEST} com intervalo de datas`, repoDir, fromMissionId: first.missionId },
      { advisor: advisor(), planCritics: [codex] },
    )
    const reasons = approvalReasons(readJson(fixed.planPath as string))

    expect(reasons.some((r) => /crítica/.test(r))).toBe(false)
    expect(reasons.length).toBeGreaterThan(0)
    expect(fixed.state).toBe('awaiting_approval')
    expect(approvals(missionDirOf(fixed.missionId))).toEqual([])
  })

  test('criterio_3_stories_alteradas_depois_da_critica_aparecem_como_critica_desatualizada', async () => {
    const { plan } = await staleMission()
    expect(approvalReasons(plan)).toContainEqual(expect.stringMatching(/^crítica desatualizada/))
  })

  test('criterio_4_ade_approve_recusa_critica_desatualizada_sem_registrar_aprovacao', async () => {
    const { missionId, plan } = await staleMission()

    const rejection = approveMission({ repoDir, missionId, expectedDigest: digest16(plan) })
    await expect(rejection).rejects.toBeInstanceOf(AdeError)
    await expect(rejection).rejects.toThrow(/--recritique/)
    const viaCli = await cli(approveCli, ['--mission', missionId, '--digest', digest16(plan), '--repo', repoDir])
    expect(viaCli.code).toBe(4)
    expect(viaCli.err).toMatch(/crítica desatualizada/)
    expect(approvals(missionDirOf(missionId))).toEqual([])
    // O `ade run` só segue sem aprovação quando não há motivo pendente.
    expect(approvalReasons(readJson(planPathOf(missionId))).length).toBeGreaterThan(0)
  })

  test('criterio_5_recritique_refaz_a_critica_sobre_as_stories_atuais_e_libera_o_approve', async () => {
    const { missionId } = await staleMission()
    const codex = critic('codex', async () => READY)

    const res = await cli(planCli, ['--mission', missionId, '--recritique', '--repo', repoDir, '--json'], { planCritics: [codex] })
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out).state).toBe('awaiting_approval')
    expect(codex.critique.mock.calls[0][0].contracts.map((c: any) => c.id)).toEqual(['S1', 'S2'])

    const plan = readJson(planPathOf(missionId))
    expect(plan.briefing.plan_critic.plan_digest).toBe(planStoriesDigest(plan))
    expect(approvalReasons(plan).some((r) => r.startsWith('crítica desatualizada'))).toBe(false)
    const approved = await approveMission({ repoDir, missionId, expectedDigest: digest16(plan) })
    expect(approved.approved).toBe(true)
  })

  test('criterio_5_recritique_falha_fechado_em_missao_inexistente_ou_ja_aprovada', async () => {
    const codex = critic('codex', async () => READY)
    const missing = await cli(planCli, ['--mission', 'mission-nada', '--recritique', '--repo', repoDir], { planCritics: [codex] })
    expect(missing.code).toBe(4)
    expect(missing.err).toMatch(/não existe/)

    const res = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [codex] })
    await approveMission({ repoDir, missionId: res.missionId, expectedDigest: res.digest as string })
    const before = fs.readFileSync(res.planPath as string, 'utf8')
    const approved = await cli(planCli, ['--mission', res.missionId, '--recritique', '--repo', repoDir], { planCritics: [codex] })
    expect(approved.code).toBe(4)
    expect(fs.readFileSync(res.planPath as string, 'utf8')).toBe(before)
  })

  test('criterio_6_criterio_do_epico_sem_story_vira_issue_novo_e_verdict_revise', async () => {
    const res = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [critic('codex', async () => READY)] })
    withEpic(res.missionId, [REQUEST, 'relatório mostra correções do usuário'])

    await cli(planCli, ['--mission', res.missionId, '--recritique', '--repo', repoDir], { planCritics: [critic('codex', async () => READY)] })
    const silent = readJson(planPathOf(res.missionId)).briefing.plan_critic
    expect(silent.verdict).toBe('revise')
    expect(silent.issues).toEqual([
      { story: 'novo', problem: expect.stringContaining('relatório mostra correções do usuário'), fix: expect.stringContaining('relatório mostra correções do usuário') },
    ])

    // Exemplo: a issue 'novo' do crítico sobre o critério é mantida e força 'revise'.
    const issue = { story: 'novo', problem: 'nenhuma story mostra as correções', fix: 'Criar story que mostra no relatório as correções feitas pelo usuário' }
    await cli(planCli, ['--mission', res.missionId, '--recritique', '--repo', repoDir], {
      planCritics: [critic('codex', async () => ({ ...READY, issues: [issue] }))],
    })
    const example = readJson(planPathOf(res.missionId)).briefing.plan_critic
    expect(example.verdict).toBe('revise')
    expect(example.issues).toEqual([issue])
  })

  test('criterio_7_prompt_da_critica_inclui_os_criterios_do_epico_e_ready_coberto_e_mantido', async () => {
    const res = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [critic('codex', async () => READY)] })
    withEpic(res.missionId, [REQUEST])
    const runWorkerImpl = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ structured_output: READY }), stderr: '' }))
    const deps = {
      adeConfig: { roles: { checker_round: { primary: { family: 'agy', model_id: 'gemini-3-pro' }, fallbacks: [] } } },
      runWorkerImpl,
      resolveBinary: (command: string) => ({ exe: command, prefixArgs: [] }),
    }

    const out = await cli(planCli, ['--mission', res.missionId, '--recritique', '--repo', repoDir], deps)
    expect(out.code).toBe(0)
    const prompt = (runWorkerImpl.mock.calls[0] as any)[0].args.join(' ')
    expect(prompt).toContain('Critérios do épico')
    expect(prompt).toContain(`- ${REQUEST}`)
    const persisted = readJson(planPathOf(res.missionId)).briefing.plan_critic
    expect(persisted).toMatchObject({ verdict: 'ready', issues: [], family: 'agy' })
  })

  test('criterio_8_critica_que_falha_nas_duas_empresas_na_revalidacao_segura_o_plano', async () => {
    const first = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [critic('codex', async () => REVISE)] })
    const failing = [
      critic('codex', async () => {
        throw new Error('código 1')
      }),
      critic('agy', async () => null),
    ]
    const fixed = await planMission(
      { request: `${REQUEST} com intervalo de datas`, repoDir, fromMissionId: first.missionId },
      { advisor: advisor(), planCritics: failing },
    )
    const plan = readJson(fixed.planPath as string)

    expect(plan.briefing.plan_critic.verdict).toBe('failed')
    expect(approvalReasons(plan)).toContain('crítica do plano falhou em codex e agy')
    expect(fixed.state).toBe('awaiting_approval')
    expect(approvals(missionDirOf(fixed.missionId))).toEqual([])
  })

  test('criterio_8_revalidacao_sem_critico_disponivel_grava_critica_failed_com_o_digest_atual', async () => {
    const first = await planMission({ request: REQUEST, repoDir }, { advisor: advisor(), planCritics: [critic('codex', async () => REVISE)] })
    const fixed = await planMission(
      { request: `${REQUEST} com intervalo de datas`, repoDir, fromMissionId: first.missionId },
      { advisor: advisor(), planCritics: [] },
    )
    const plan = readJson(fixed.planPath as string)

    expect(plan.briefing.plan_critic).toMatchObject({ verdict: 'failed', attempts: [], plan_digest: planStoriesDigest(plan), revalidated: true })
    expect(approvalReasons(plan)).toContain(`crítica do plano falhou: nenhum crítico disponível; rode ade plan --mission ${fixed.missionId} --recritique`)
    expect(fixed.state).toBe('awaiting_approval')
    expect(approvals(missionDirOf(fixed.missionId))).toEqual([])
  })
})
