import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { main as approveCli } from '../src/cli/approve.ts'
import { generateProductBriefing } from '../src/intent/briefing.ts'
import { AdeError } from '../src/journal/errors.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { approveMission, planMission } from '../src/mission/plan-lifecycle.ts'
import { validate } from '../src/schema/index.ts'

const advisorOf = (complexity: string) =>
  vi.fn().mockResolvedValue({
    complexity,
    confidence: 0.9,
    domains: ['backend'],
    rationale: 'dublê',
    cost: { usd: 0.01, model_calls: 1, model_id: 'claude-haiku-4-5' },
  })

const discovery = {
  repo: { head: 'HEAD', dirty: false },
  scripts: { test: 'node --test' },
  languages: [{ name: 'javascript', share: 1 }],
  anchors: [],
  ui: { present: false },
  existing_features: ['login'],
  repo_rules: ['Nunca use npx'],
}

const threeVersions = {
  title: 'Agenda completa',
  goal: 'Marcar e acompanhar compromissos.',
  users: 'Quem organiza a própria semana.',
  in_scope: ['cadastrar compromissos', 'lembrete por email', 'agenda compartilhada'],
  out_of_scope: ['aplicativo de celular'],
  done_means: ['compromisso criado aparece na lista'],
  constraints: [],
  versions: [
    { name: 'v1', goal: 'Cadastro básico', includes: ['cadastrar compromissos'] },
    { name: 'v2', goal: 'Lembretes', includes: ['lembrete por email'] },
    { name: 'v3', goal: 'Compartilhar', includes: ['agenda compartilhada'] },
  ],
}

const REQUEST = 'crie um app de agenda completo'
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
const decisionsOf = (missionDir: string) =>
  readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e) => e.kind === 'decision').map((e) => e.data)

describe('Briefing de pedido grande aprovado pelo usuário', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-product-briefing-'))
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }))
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  const depsOf = (complexity: string, brief: any = threeVersions) => ({
    discovery,
    unknowns: [],
    planCritics: [],
    advisor: advisorOf(complexity),
    briefer: vi.fn().mockResolvedValue(structuredClone(brief)),
  })
  const missionDirOf = (missionId: string) => path.join(repoDir, '.ade', 'missions', missionId)

  test('criterio_1_pedido_project_ou_subsystem_grava_briefing_e_para_em_awaiting_briefing_approval_sem_stories', async () => {
    const res = await planMission({ request: REQUEST, repoDir }, depsOf('project'))
    const missionDir = missionDirOf(res.missionId)

    expect(res.state).toBe('awaiting_briefing_approval')
    expect(res.planPath).toBeNull()
    expect(readJson(path.join(missionDir, 'briefing.json')).title).toBe('Agenda completa')
    expect(fs.existsSync(path.join(missionDir, 'plan.json'))).toBe(false)
    expect(fs.existsSync(path.join(missionDir, 'stories'))).toBe(false)

    const sub = await planMission({ request: 'reescrever o subsistema de pagamentos', repoDir }, depsOf('subsystem'))
    expect(sub.state).toBe('awaiting_briefing_approval')
  })

  test('criterio_2_pedido_bounded_ou_feature_segue_sem_briefing_de_produto', async () => {
    for (const complexity of ['bounded', 'feature']) {
      const deps = depsOf(complexity)
      const res = await planMission({ request: `adicionar filtro por data ${complexity}`, repoDir }, deps)
      const missionDir = missionDirOf(res.missionId)

      expect(res.state).toBe('planned')
      expect(deps.briefer).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(missionDir, 'briefing.json'))).toBe(false)
      expect(readJson(res.planPath as string).briefing.product).toBeUndefined()
      const approval = await approveMission({ repoDir, missionId: res.missionId, expectedDigest: res.digest as string })
      expect(approval.approved).toBe(true)
    }
  })

  test('criterio_3_recurso_ja_existente_sai_do_in_scope_e_vai_para_fora_do_escopo', async () => {
    const brief = {
      ...threeVersions,
      in_scope: ['login', 'agenda'],
      versions: [{ name: 'v1', goal: 'Agenda', includes: ['login', 'agenda'] }],
    }
    const res = await planMission({ request: REQUEST, repoDir }, depsOf('project', brief))
    const saved = readJson(path.join(missionDirOf(res.missionId), 'briefing.json'))

    expect(saved.in_scope).toEqual(['agenda'])
    expect(saved.out_of_scope).toContain('login (já existe)')
    expect(saved.versions[0].includes).toEqual(['agenda'])
  })

  test('criterio_4_regras_do_repositorio_entram_nas_constraints_quando_o_briefer_as_omite', async () => {
    const res = await planMission({ request: REQUEST, repoDir }, depsOf('project', { ...threeVersions, constraints: [] }))
    const saved = readJson(path.join(missionDirOf(res.missionId), 'briefing.json'))

    expect(saved.constraints).toContain('Nunca use npx')

    const direct = await generateProductBriefing(
      { request: REQUEST, discovery, classification: { complexity: 'project' } },
      async () => ({ ...threeVersions, constraints: ['Nunca use npx'] }),
    )
    expect(direct.constraints.filter((c) => c === 'Nunca use npx')).toHaveLength(1)
  })

  test('criterio_5_ade_approve_registra_briefing_approved_com_digest_e_compila_plano_em_awaiting_approval', async () => {
    const deps = depsOf('project')
    const res = await planMission({ request: REQUEST, repoDir }, deps)
    const missionDir = missionDirOf(res.missionId)
    const out: string[] = []

    const code = await approveCli(['--mission', res.missionId, '--digest', res.digest as string, '--repo', repoDir, '--json'], {
      ...deps,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
    })

    expect(code).toBe(0)
    const decisions = decisionsOf(missionDir)
    expect(decisions).toContainEqual(expect.objectContaining({ decision: 'briefing_approved', digest: res.digest }))
    expect(decisions.some((d) => d.decision === 'plan_approved')).toBe(false)
    const plan = readJson(path.join(missionDir, 'plan.json'))
    expect(plan.briefing.product.title).toBe('Agenda completa')
    expect(plan.briefing.version_index).toBe(0)
    expect(JSON.parse(out.join('')).state).toBe('awaiting_approval')
  })

  test('criterio_6_plano_com_tres_versoes_cobre_so_a_versao_atual_e_poe_as_seguintes_fora_do_escopo', async () => {
    const deps = depsOf('project')
    const res = await planMission({ request: REQUEST, repoDir }, deps)
    const approval = await approveMission({ repoDir, missionId: res.missionId, expectedDigest: res.digest as string }, deps)
    const missionDir = missionDirOf(res.missionId)
    const plan = readJson(path.join(missionDir, 'plan.json'))
    const tasks = plan.phases[0].epics[0].stories.map((id: string) => readJson(path.join(missionDir, 'stories', `${id}.json`)).task)

    expect(approval.approved).toBe(true)
    expect(tasks).toEqual(['cadastrar compromissos'])
    expect(plan.briefing.out_of_scope).toEqual(expect.arrayContaining(['lembrete por email', 'agenda compartilhada', 'aplicativo de celular']))
  })

  test('criterio_7_plan_from_de_versao_entregue_cobre_a_proxima_versao_sem_nova_aprovacao_do_briefing', async () => {
    const deps = depsOf('project')
    const res = await planMission({ request: REQUEST, repoDir }, deps)
    await approveMission({ repoDir, missionId: res.missionId, expectedDigest: res.digest as string }, deps)
    const missionDir = missionDirOf(res.missionId)
    const plan = readJson(path.join(missionDir, 'plan.json'))
    const planApproval = await approveMission({ repoDir, missionId: res.missionId, expectedDigest: (await import('../src/journal/canonical.ts')).digest16(plan) }, deps)
    expect(planApproval.approved).toBe(true)

    const journal = openJournal({ missionDir, runtimeStamp: '1:0123456789abcdef:0123456789abcdef' })
    for (const id of plan.phases[0].epics[0].stories) {
      await journal.append({ kind: 'story_done', unit: id, data: { unit: id, status: 'committed', commit: 'abc123' } })
    }
    await journal.close()

    const next = await planMission({ request: REQUEST, repoDir, fromMissionId: res.missionId }, deps)
    const nextDir = missionDirOf(next.missionId)
    const nextPlan = readJson(next.planPath as string)
    const tasks = nextPlan.phases[0].epics[0].stories.map((id: string) => readJson(path.join(nextDir, 'stories', `${id}.json`)).task)

    expect(nextPlan.briefing.version_index).toBe(1)
    expect(tasks).toEqual(['lembrete por email'])
    expect(nextPlan.briefing.out_of_scope).toContain('agenda compartilhada')
    expect(next.state).toBe('awaiting_approval')
    const approval = await approveMission({ repoDir, missionId: next.missionId, expectedDigest: next.digest as string }, deps)
    expect(approval.approved).toBe(true)
  })

  test('criterio_8_briefing_sem_versoes_ou_sem_in_scope_falha_com_AdeError_e_nada_aprovavel', async () => {
    for (const bad of [{ ...threeVersions, versions: [] }, { ...threeVersions, in_scope: [] }]) {
      const deps = depsOf('project', bad)
      await expect(planMission({ request: REQUEST, repoDir }, deps)).rejects.toBeInstanceOf(AdeError)
    }
    await expect(
      planMission({ request: REQUEST, repoDir }, { ...depsOf('project'), briefer: undefined }),
    ).rejects.toBeInstanceOf(AdeError)

    const missionsDir = path.join(repoDir, '.ade', 'missions')
    const leftovers = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).flatMap((m) => fs.readdirSync(path.join(missionsDir, m)))
      : []
    expect(leftovers).not.toContain('plan.json')
    expect(leftovers).not.toContain('briefing.json')
  })

  test('criterio_9_briefing_alterado_depois_da_aprovacao_faz_approve_do_plano_recusar', async () => {
    const deps = depsOf('project')
    const res = await planMission({ request: REQUEST, repoDir }, deps)
    const missionDir = missionDirOf(res.missionId)
    await approveMission({ repoDir, missionId: res.missionId, expectedDigest: res.digest as string }, deps)
    const briefingPath = path.join(missionDir, 'briefing.json')
    fs.writeFileSync(briefingPath, JSON.stringify({ ...readJson(briefingPath), goal: 'outro objetivo' }))

    const { digest16 } = await import('../src/journal/canonical.ts')
    const approval = await approveMission(
      { repoDir, missionId: res.missionId, expectedDigest: digest16(readJson(path.join(missionDir, 'plan.json'))) },
      deps,
    )

    expect(approval.approved).toBe(false)
    expect(approval.reason).toMatch(/briefing/)
    expect(decisionsOf(missionDir).some((d) => d.decision === 'plan_approved')).toBe(false)
  })

  test('criterio_10_plan_antigo_sem_briefing_de_produto_continua_valido_e_campos_novos_sao_tipados', () => {
    const oldPlan = {
      format_version: 2,
      id: 'plan-1',
      mission_id: 'mission-1',
      immutable_digest: 'abc',
      authorization: { autonomy: 'safe', permitted_effects: [], eligible_skills: [] },
      phases: [{ epics: [{ stories: ['S1'] }] }],
      mission_budget: { max_usd: 10 },
      budget: { max_model_calls: 3, max_rework_rounds: 1 },
    }
    expect(validate('plan', oldPlan).valid).toBe(true)
    expect(validate('plan', { ...oldPlan, briefing: { product: threeVersions, version_index: 0 } }).valid).toBe(true)
    expect(validate('plan', { ...oldPlan, briefing: { product: { ...threeVersions, versions: [] }, version_index: 0 } }).valid).toBe(false)
    expect(validate('plan', { ...oldPlan, briefing: { product: threeVersions, version_index: 'x' } }).valid).toBe(false)
  })
})
