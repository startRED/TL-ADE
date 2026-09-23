import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { compileIntent } from '../src/intent/compiler.ts'
import { approvalReasons, planIssues } from '../src/intent/proportional.ts'
import { approveMission, planMission, validateMissionPlan } from '../src/mission/plan-lifecycle.ts'

const advisorOf = (complexity: string) =>
  vi.fn().mockResolvedValue({
    complexity,
    confidence: 0.9,
    domains: ['backend'],
    rationale: 'dublê',
    cost: { usd: 0.01, model_calls: 1, model_id: 'claude-haiku-4-5' },
  })

const readPlan = (planPath: string) => JSON.parse(fs.readFileSync(planPath, 'utf8'))

describe('Planejador proporcional com decisões humanas', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-proportional-'))
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }))
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('criterio_1_pedido_simples_com_uma_parte_e_aceito_e_plano_grande_nao_e_truncado', async () => {
    const simple = await planMission(
      { request: 'Adicionar filtro por data na listagem de pedidos', repoDir },
      { advisor: advisorOf('feature') },
    )
    const simplePlan = readPlan(simple.planPath)
    expect(simplePlan.phases[0].epics[0].stories).toEqual(['S1'])
    expect(simple.state).toBe('planned')
    expect(validateMissionPlan(simple.planPath).valid).toBe(true)

    const deliverables = [
      'criar cadastro de clientes',
      'criar cadastro de produtos',
      'criar carrinho de compras',
      'criar histórico de pedidos',
      'criar relatório de vendas',
      'criar exportação em planilha',
      'criar notificações por email',
    ]
    const { plan, contracts } = await compileIntent({
      request: deliverables.join(', '),
      advisor: advisorOf('project'),
    })
    expect(contracts.map((c) => c.task)).toEqual(deliverables)
    expect(plan.phases[0].epics[0].stories).toHaveLength(7)
    expect(plan.briefing.future_intent).toBeUndefined()

    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `S${i + 1}`,
      request: `entrega ${i + 1}`,
      acceptance: [`resultado ${i + 1}`],
      scope_paths: ['src/**'],
      depends_on: i > 0 ? [`S${i}`] : [],
    }))
    expect(planIssues({ stories: many.slice(0, 1) })).toEqual([])
    expect(planIssues({ stories: many })).toEqual([])
  })

  test('criterio_1_borda_plano_com_falha_estrutural_continua_rejeitado', () => {
    const story = { id: 'S1', request: 'entrega', acceptance: ['ok'], scope_paths: ['src/**'] }
    expect(planIssues({ stories: [] })).toEqual([{ story: '-', problem: 'Plano sem stories' }])
    expect(planIssues({ stories: [{ ...story, depends_on: ['S9'] }] })).toEqual([
      { story: 'S1', problem: 'dependência S9 não existe antes desta story' },
    ])
    expect(planIssues({ stories: [{ ...story, human_decision: { reason: ' ' } }] })).toEqual([
      { story: 'S1', problem: 'decisão humana sem motivo' },
    ])
  })

  test('criterio_2_story_que_exige_dado_so_do_operador_vira_decisao_humana_e_plano_aguarda_aprovacao', async () => {
    const result = await planMission(
      { request: 'Exibir o preço real do plano Pro na página de vendas', repoDir },
      { advisor: advisorOf('bounded') },
    )
    const plan = readPlan(result.planPath)

    expect(plan.briefing.human_decisions.S1.reason).toMatch(/preço real/)
    expect(result.state).toBe('awaiting_approval')
    expect(approvalReasons(plan)).toEqual([expect.stringMatching(/^S1: .*preço real/)])
    expect(result.questions).toContainEqual(expect.objectContaining({ id: 'Q-human-S1', kind: 'human_decision' }))

    // O fluxo existente de approve continua sendo o caminho para liberar o plano.
    const approved = await approveMission({ repoDir, missionId: result.missionId, expectedDigest: result.digest })
    expect(approved.approved).toBe(true)

    const plain = await compileIntent({ request: 'Exibir o preço do plano Pro calculado pela tabela do repositório' })
    expect(plain.plan.briefing.human_decisions).toBeUndefined()
  })

  test('criterio_3_critica_falha_na_primaria_repete_com_outra_empresa_e_registra_a_troca', async () => {
    const codexFail = vi.fn().mockRejectedValue(new Error('timeout de 8 min'))
    const codexSecond = vi.fn()
    const agyOk = vi.fn().mockResolvedValue({ verdict: 'ready', summary: 'executável', issues: [] })

    const result = await planMission(
      { request: 'Adicionar filtro por data na listagem de pedidos', repoDir },
      {
        advisor: advisorOf('feature'),
        planCritics: [
          { family: 'codex', model: 'gpt-5.5', critique: codexFail },
          { family: 'codex', model: 'gpt-5.5-mini', critique: codexSecond },
          { family: 'agy', model: 'gemini-3-pro', critique: agyOk },
        ],
      },
    )
    const plan = readPlan(result.planPath)

    expect(codexFail).toHaveBeenCalledTimes(1)
    expect(codexSecond).not.toHaveBeenCalled()
    expect(agyOk).toHaveBeenCalledTimes(1)
    expect(plan.briefing.plan_critic).toEqual({
      verdict: 'ready',
      summary: 'executável',
      issues: [],
      family: 'agy',
      model: 'gemini-3-pro',
      attempts: [{ family: 'codex', model: 'gpt-5.5', error: 'timeout de 8 min' }],
    })
    expect(result.state).toBe('planned')
  })

  test('criterio_3_falha_nas_duas_empresas_nao_aprova_o_plano_sozinho', async () => {
    const result = await planMission(
      { request: 'Adicionar filtro por data na listagem de pedidos', repoDir },
      {
        advisor: advisorOf('feature'),
        planCritics: [
          { family: 'codex', model: 'gpt-5.5', critique: vi.fn().mockRejectedValue(new Error('código 1')) },
          { family: 'agy', model: 'gemini-3-pro', critique: vi.fn().mockResolvedValue(null) },
        ],
      },
    )
    const plan = readPlan(result.planPath)

    expect(plan.briefing.plan_critic.verdict).toBe('failed')
    expect(plan.briefing.plan_critic.attempts).toEqual([
      { family: 'codex', model: 'gpt-5.5', error: 'código 1' },
      { family: 'agy', model: 'gemini-3-pro', error: 'resposta sem verdict' },
    ])
    expect(result.state).toBe('awaiting_approval')
    expect(approvalReasons(plan)).toContain('crítica do plano falhou em codex e agy')
  })

  test('criterio_3_ade_plan_usa_os_criticos_dos_papeis_configurados_quando_o_plano_e_de_alto_risco', async () => {
    const runWorkerImpl = vi.fn(async ({ resolved }: any) =>
      resolved.exe === 'codex'
        ? { exitCode: 1, stdout: '', stderr: 'cota esgotada' }
        : { exitCode: 0, stdout: JSON.stringify({ structured_output: { verdict: 'ready', summary: 'executável', issues: [] } }), stderr: '' },
    )
    const deps = {
      adeConfig: {
        roles: {
          maker: { primary: { family: 'claude', model_id: 'claude-opus-5-5' }, fallbacks: [] },
          checker_round: { primary: { family: 'codex', model_id: 'gpt-5.5' }, fallbacks: [{ family: 'agy', model_id: 'gemini-3-pro' }] },
        },
      },
      runWorkerImpl,
      resolveBinary: (command: string) => ({ exe: command, prefixArgs: [] }),
    }
    const database = vi.fn().mockResolvedValue({
      complexity: 'feature',
      confidence: 0.9,
      domains: ['database'],
      rationale: 'dublê',
      cost: { usd: 0.01, model_calls: 1, model_id: 'claude-haiku-4-5' },
    })

    const risky = await planMission({ request: 'Adicionar índice na tabela de pedidos', repoDir }, { ...deps, advisor: database })
    const plan = readPlan(risky.planPath)

    expect(runWorkerImpl.mock.calls.map(([opts]: any) => opts.resolved.exe)).toEqual(['codex', 'agy'])
    expect(plan.briefing.plan_critic).toMatchObject({
      verdict: 'ready',
      family: 'agy',
      model: 'gemini-3-pro',
      attempts: [{ family: 'codex', model: 'gpt-5.5', error: expect.stringContaining('código 1') }],
    })
    expect(risky.state).toBe('planned')

    // Plano sem risco não gasta chamada de crítica.
    const plain = await planMission({ request: 'Mostrar total de pedidos no rodapé', repoDir }, { ...deps, advisor: advisorOf('feature') })
    expect(runWorkerImpl).toHaveBeenCalledTimes(2)
    expect(readPlan(plain.planPath).briefing.plan_critic).toBeUndefined()
  })
})
