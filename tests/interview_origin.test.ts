import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { buildInterview } from '../src/intent/interview.ts'
import { planMission, resumeMissionAnswers } from '../src/mission/plan-lifecycle.ts'
import { main as planCli } from '../src/cli/plan.ts'
import { AdeError } from '../src/journal/errors.ts'
import { validate } from '../src/schema/index.ts'

const advisorDouble = () =>
  vi.fn().mockResolvedValue({
    complexity: 'feature',
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
  facts: { database: 'postgresql' },
}

const productUnknowns = [
  { id: 'U1', question: 'Qual moeda padrão dos relatórios?', kind: 'product_choice' },
  { id: 'U2', question: 'Permitir exportação em planilha?', kind: 'product_choice' },
]

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

describe('Entrevista antes do plano com origem das decisões', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-interview-origin-'))
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }))
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  const suspend = async (advisor = advisorDouble()) =>
    planMission(
      { request: 'Criar relatório de vendas', repoDir },
      { unknowns: productUnknowns, discovery, planCritics: [], advisor },
    )

  test('criterio_1_duvida_de_produto_sem_resposta_em_modo_interativo_suspende_em_awaiting_answers_sem_plano', async () => {
    const advisor = advisorDouble()
    const res = await suspend(advisor)

    expect(res.state).toBe('awaiting_answers')
    expect(res.planPath).toBeNull()
    expect(res.digest).toBeNull()
    expect(res.questions.map((q) => q.id)).toEqual(['Q1', 'Q2'])

    const missionDir = path.join(repoDir, '.ade', 'missions', res.missionId)
    const context = readJson(path.join(missionDir, 'context.json'))
    expect(context.questions.map((q: any) => q.id)).toEqual(['Q1', 'Q2'])
    expect(fs.existsSync(path.join(missionDir, 'plan.json'))).toBe(false)
    expect(fs.existsSync(path.join(missionDir, 'stories'))).toBe(false)
    expect(advisor).not.toHaveBeenCalled()
  })

  test('criterio_2_respostas_retomam_a_mesma_missao_sem_refazer_descoberta_nem_perguntas', async () => {
    const advisor = advisorDouble()
    const suspended = await suspend(advisor)
    const missionDir = path.join(repoDir, '.ade', 'missions', suspended.missionId)
    const before = readJson(path.join(missionDir, 'context.json'))

    const otherDiscovery = { ...discovery, facts: { database: 'mysql' }, scripts: { test: 'jest' } }
    const res = await resumeMissionAnswers(
      {
        missionId: suspended.missionId,
        repoDir,
        answers: [{ question_id: 'Q1', option_id: 'opt-0-recommended' }],
      },
      { advisor, planCritics: [], discovery: otherDiscovery, unknowns: [{ id: 'UX', question: 'Outra dúvida?' }] },
    )

    expect(res.missionId).toBe(suspended.missionId)
    expect(res.planPath).toBe(path.join(missionDir, 'plan.json'))
    expect(fs.existsSync(path.join(missionDir, 'plan.json'))).toBe(true)
    expect(res.state).toBe('planned')
    expect(advisor).toHaveBeenCalledTimes(1)

    const after = readJson(path.join(missionDir, 'context.json'))
    expect(after.discovery).toEqual(before.discovery)
    expect(after.questions).toEqual(before.questions)
    expect(after.state).toBeUndefined()

    const plan = readJson(res.planPath as string)
    expect(validate('plan', plan).valid).toBe(true)
    expect(plan.briefing.decisions).toContainEqual(
      expect.objectContaining({ question_id: 'Q1', value: 'opt-0-recommended', origin: 'usuario' }),
    )

    // O mesmo caminho pelo comando `ade plan --mission <id> --answers <arquivo.json>`.
    const cliRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-interview-cli-'))
    try {
      const cliSuspended = await planMission(
        { request: 'Criar relatório de vendas', repoDir: cliRepo },
        { unknowns: productUnknowns, discovery, planCritics: [] },
      )
      const answersPath = path.join(cliRepo, 'respostas.json')
      fs.writeFileSync(answersPath, JSON.stringify([{ question_id: 'Q2', option_id: 'dont_know' }]))
      let out = ''
      const code = await planCli(['--mission', cliSuspended.missionId, '--answers', answersPath, '--repo', cliRepo], {
        stdout: (s: string) => { out += s },
        stderr: (s: string) => { out += s },
        planCritics: [],
      })
      expect(code, out).toBe(0)
      const cliPlan = readJson(path.join(cliRepo, '.ade', 'missions', cliSuspended.missionId, 'plan.json'))
      expect(cliPlan.briefing.decisions).toContainEqual(
        expect.objectContaining({ question_id: 'Q2', value: 'opt-1-recommended', origin: 'padrao' }),
      )
    } finally {
      fs.rmSync(cliRepo, { recursive: true, force: true })
    }
  })

  test('criterio_3_missao_inexistente_falha_com_ade_error_sem_gravar_nada', async () => {
    await expect(
      resumeMissionAnswers({ missionId: 'm-inexistente', repoDir, answers: [] }, { planCritics: [] }),
    ).rejects.toBeInstanceOf(AdeError)
    expect(fs.existsSync(path.join(repoDir, '.ade'))).toBe(false)

    const answersPath = path.join(repoDir, 'respostas.json')
    fs.writeFileSync(answersPath, '[]')
    let err = ''
    const code = await planCli(['--mission', 'm-inexistente', '--answers', answersPath, '--repo', repoDir], {
      stdout: () => {},
      stderr: (s: string) => { err += s },
    })
    expect(code).not.toBe(0)
    expect(err).toContain('m-inexistente')
    expect(fs.existsSync(path.join(repoDir, '.ade'))).toBe(false)
  })

  test('criterio_4_missao_fora_de_awaiting_answers_falha_nomeando_o_estado_e_plano_nao_muda', async () => {
    const critic = {
      family: 'codex',
      model: 'gpt-5.5',
      critique: async () => ({ verdict: 'revise', summary: 'falta prova', issues: [] }),
    }
    const planned = await planMission(
      { request: 'Criar relatório de vendas', repoDir, nonInteractive: true },
      { unknowns: productUnknowns, discovery, planCritics: [critic], advisor: advisorDouble() },
    )
    expect(planned.state).toBe('awaiting_approval')
    const planBefore = fs.readFileSync(planned.planPath as string, 'utf8')

    // Exemplo: m-abc em awaiting_approval.
    const src = path.dirname(planned.planPath as string)
    const mAbc = path.join(repoDir, '.ade', 'missions', 'm-abc')
    fs.cpSync(src, mAbc, { recursive: true })

    const run = resumeMissionAnswers(
      { missionId: 'm-abc', repoDir, answers: [{ question_id: 'Q1', option_id: 'opt-0-recommended' }] },
      { planCritics: [] },
    )
    await expect(run).rejects.toBeInstanceOf(AdeError)
    await expect(run).rejects.toThrow('missão m-abc está em awaiting_approval, não aguarda respostas')
    expect(fs.readFileSync(path.join(mAbc, 'plan.json'), 'utf8')).toBe(planBefore)
  })

  test('criterio_5_sete_duvidas_distintas_viram_no_maximo_cinco_perguntas_com_recomendacao_primeiro_e_nao_sei', () => {
    const unknowns = [
      { id: 'U1', question: 'Qual moeda padrão do checkout?', kind: 'product_choice' },
      { id: 'U2', question: 'Permitir cupons na primeira compra?', kind: 'product_choice' },
      { id: 'U3', question: 'Habilitar login social com Google?', kind: 'product_choice' },
      {
        id: 'U4',
        question: 'Enviar e-mail transacional via SendGrid?',
        kind: 'product_choice',
        options: [
          { id: 'opt-smtp', label: 'SMTP próprio' },
          { id: 'opt-sendgrid', label: 'SendGrid', recommended: true },
        ],
      },
      { id: 'U5', question: 'Exigir autenticação de dois fatores?', kind: 'product_choice' },
      { id: 'U6', question: 'Ativar modo escuro por padrão?', kind: 'product_choice' },
      { id: 'U7', question: 'Guardar histórico de pedidos por quantos anos?', kind: 'product_choice' },
    ]
    const questions = buildInterview({ unknowns })

    expect(questions).toHaveLength(5)
    for (const q of questions) {
      expect(q.options[0].recommended).toBe(true)
      expect(q.options.some((o: any) => o.label.includes('Não sei'))).toBe(true)
    }
    expect(questions[3].options[0].id).toBe('opt-sendgrid')
  })

  test('criterio_6_opcao_escolhida_pelo_usuario_vira_decisao_com_origem_usuario', async () => {
    const suspended = await suspend()
    const res = await resumeMissionAnswers(
      {
        missionId: suspended.missionId,
        repoDir,
        answers: [
          { question_id: 'Q1', option_id: 'opt-0-recommended' },
          { question_id: 'Q2', option_id: 'opt-1-alt' },
        ],
      },
      { planCritics: [], advisor: advisorDouble() },
    )
    const decisions = readJson(res.planPath as string).briefing.decisions
    expect(decisions).toContainEqual(
      expect.objectContaining({ question_id: 'Q1', value: 'opt-0-recommended', origin: 'usuario' }),
    )
    expect(decisions).toContainEqual(expect.objectContaining({ question_id: 'Q2', value: 'opt-1-alt', origin: 'usuario' }))
  })

  test('criterio_7_nao_sei_ou_sem_resposta_em_modo_nao_interativo_adota_recomendacao_com_origem_padrao', async () => {
    const suspended = await suspend()
    const resumed = await resumeMissionAnswers(
      { missionId: suspended.missionId, repoDir, answers: [{ question_id: 'Q1', option_id: 'dont_know' }] },
      { planCritics: [], advisor: advisorDouble() },
    )
    const resumedDecisions = readJson(resumed.planPath as string).briefing.decisions
    expect(resumedDecisions).toContainEqual(
      expect.objectContaining({ question_id: 'Q1', value: 'opt-0-recommended', origin: 'padrao' }),
    )

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-interview-ni-'))
    try {
      const planned = await planMission(
        { request: 'Criar relatório de vendas', repoDir: other, nonInteractive: true },
        { unknowns: productUnknowns, discovery, planCritics: [], advisor: advisorDouble() },
      )
      expect(planned.state).toBe('planned')
      const decisions = readJson(planned.planPath as string).briefing.decisions
      expect(decisions).toContainEqual(
        expect.objectContaining({ question_id: 'Q1', value: 'opt-0-recommended', origin: 'padrao' }),
      )
      expect(decisions).toContainEqual(
        expect.objectContaining({ question_id: 'Q2', value: 'opt-1-recommended', origin: 'padrao' }),
      )
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test('criterio_8_duvida_resolvida_sem_perguntar_fica_com_origem_ia_supondo_e_motivo', async () => {
    const planned = await planMission(
      { request: 'Criar relatório de vendas', repoDir, nonInteractive: true },
      {
        unknowns: [
          { id: 'U9', question: 'Qual versão da API de câmbio usar?', kind: 'external_fact' },
          { id: 'U10', question: 'Qual o banco de dados usado?', kind: 'repo_fact' },
        ],
        discovery,
        planCritics: [],
        advisor: advisorDouble(),
        policy: { allow_research: false },
      },
    )
    const decisions = readJson(planned.planPath as string).briefing.decisions
    const fallback = decisions.find((d: any) => d.unknown_id === 'U9')
    expect(fallback).toMatchObject({ origin: 'ia_supondo' })
    expect(fallback.rationale).toContain('Pesquisa desabilitada')
    const repoFact = decisions.find((d: any) => d.unknown_id === 'U10')
    expect(repoFact).toMatchObject({ origin: 'ia_supondo' })
    expect(repoFact.rationale).toContain('postgresql')
  })

  test('criterio_9_decisoes_com_origem_ficam_no_briefing_do_plano_e_no_context_json', async () => {
    const suspended = await suspend()
    const res = await resumeMissionAnswers(
      { missionId: suspended.missionId, repoDir, answers: [{ question_id: 'Q1', option_id: 'opt-0-alt' }] },
      { planCritics: [], advisor: advisorDouble() },
    )
    const missionDir = path.dirname(res.planPath as string)
    const plan = readJson(res.planPath as string)
    const context = readJson(path.join(missionDir, 'context.json'))
    expect(plan.briefing.decisions).toHaveLength(2)
    expect(context.decisions).toEqual(plan.briefing.decisions)
    expect(context.answers).toEqual([{ question_id: 'Q1', option_id: 'opt-0-alt' }])

    // As decisões entram no digest aprovado.
    const altered = { ...plan, briefing: { ...plan.briefing, decisions: [] } }
    const { digest16 } = await import('../src/journal/canonical.ts')
    expect(digest16(altered)).not.toBe(res.digest)
    expect(digest16(plan)).toBe(res.digest)
  })

  test('criterio_10_resposta_com_pergunta_ou_opcao_inexistente_falha_nomeando_a_pergunta_sem_gravar_plano', async () => {
    const suspended = await suspend()
    const missionDir = path.join(repoDir, '.ade', 'missions', suspended.missionId)

    await expect(
      resumeMissionAnswers(
        { missionId: suspended.missionId, repoDir, answers: [{ question_id: 'Q7', option_id: 'opt-0-recommended' }] },
        { planCritics: [], advisor: advisorDouble() },
      ),
    ).rejects.toThrow(/Q7/)
    const badOption = resumeMissionAnswers(
      { missionId: suspended.missionId, repoDir, answers: [{ question_id: 'Q2', option_id: 'opt-inventada' }] },
      { planCritics: [], advisor: advisorDouble() },
    )
    await expect(badOption).rejects.toBeInstanceOf(AdeError)
    await expect(badOption).rejects.toThrow(/Q2/)

    expect(fs.existsSync(path.join(missionDir, 'plan.json'))).toBe(false)
    expect(fs.existsSync(path.join(missionDir, 'stories'))).toBe(false)
    expect(readJson(path.join(missionDir, 'context.json')).state).toBe('awaiting_answers')
  })
})
