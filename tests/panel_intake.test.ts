import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createIntake, type IntentPort } from '../src/panel/intake.ts'
import { validateMissionPlan } from '../src/mission/plan-lifecycle.ts'
import type { ProductBriefing } from '../src/intent/briefing.ts'

type CompileInput = Parameters<IntentPort['compile']>[0]
type CompileResult = Awaited<ReturnType<IntentPort['compile']>>

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const file = (name: string, bytes: Buffer) => ({ name, data: bytes.toString('base64') })

function makeFakeIntent(responses: CompileResult[]) {
  const calls: CompileInput[] = []
  const queue = [...responses]
  const intent: IntentPort = {
    async compile(input) {
      calls.push(input)
      const res = queue.shift()
      if (!res) throw new Error('fakeIntent: nenhuma resposta configurada para esta chamada')
      return res
    },
  }
  return { intent, calls }
}

const questionsResult: CompileResult = {
  questions: [
    {
      id: 'q1',
      question: 'Qual tema visual?',
      options: [
        { id: 'opt_dark', label: 'Escuro' },
        { id: 'opt_light', label: 'Claro' },
      ],
    },
  ],
  understanding: {
    summary: 'Construir painel de controle.',
    complexity: 'bounded',
    difficulty: 'normal',
    domains: ['web'],
    needs_ui: true,
  },
}

const sampleBriefing: ProductBriefing = {
  title: 'Painel de Controle',
  goal: 'Gerenciar métricas.',
  users: 'Operadores',
  in_scope: ['Visualizar métricas'],
  out_of_scope: ['Editar configurações'],
  done_means: ['Métricas na tela'],
  constraints: ['Node 24'],
  versions: [{ name: 'v1', goal: 'Métricas básicas', includes: ['Visualizar métricas'] }],
}

const briefingResult: CompileResult = {
  briefing: sampleBriefing,
  understanding: {
    summary: 'Painel de controle com métricas.',
    complexity: 'bounded',
    difficulty: 'normal',
    domains: ['web'],
    needs_ui: true,
  },
}

function makePlanAndContracts(missionId = 'test-mission') {
  const contract = {
    format_version: 2,
    id: 'S1',
    title: 'Exibir métricas principais',
    complexity: 'bounded',
    needs_ui: true,
    task: 'Renderizar gráficos no painel',
    workspace: { kind: 'git', root: '.', revision: 'HEAD' },
    risk: { level: 'normal', surfaces: [], evidence: [] },
    guardrails: { scope_paths: ['src/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
    requirements: [{ id: 'R1', ears: 'WHEN abrir tela THE SYSTEM SHALL mostrar gráficos' }],
    scenarios: [{ id: 'C1', given: 'tela aberta', when: 'carrega', then: 'mostra gráficos', verifiers: ['V1'] }],
    verifiers: [
      {
        id: 'V1',
        kind: 'script',
        cmd: ['node', '-v'],
        expect_exit: 0,
        timeout_s: 30,
        max_output_bytes: 1024,
        evidence: ['package.json'],
        strictness: { mode: 'must_fail_before' },
        author: 'operator',
      },
    ],
    skills: [],
    roles: { maker: { family: 'claude', model_id: 'claude-sonnet-5' }, checker_round: { family: 'codex', model_id: 'codex-1' } },
    budget: { max_model_calls: 3, max_rework_rounds: 1 },
    unknowns: [],
  }

  const plan = {
    format_version: 2,
    id: 'plan-1',
    mission_id: missionId,
    immutable_digest: 'abcdef0123456789',
    intent: 'Painel de métricas',
    briefing: {
      request: 'Renderizar gráficos',
      epics: [{ id: 'epic-1', title: 'Métricas' }],
      design_briefs: {
        S1: { direction: { self_critique: 'Gráficos SVG' } },
      },
    },
    authorization: {
      autonomy: 'safe',
      permitted_effects: ['push'],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['S1'],
          },
        ],
      },
    ],
    mission_budget: { max_usd: 5.0 },
    budget: { max_model_calls: 10, max_rework_rounds: 1 },
  }

  return { plan, contracts: [contract] }
}

describe('Planejador e maker recebem os anexos (Story S2)', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-panel-intake-test-'))
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'vitest run' } }))
  })

  afterEach(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  })

  test('C2.1 dado um pedido com anexos enviado a uma porta de intenção dublê que guarda o que recebe, quando a porta é chamada para entender o pedido, então o pedido recebido cita o caminho absoluto de cada anexo dentro da pasta attachments da missão', async () => {
    const { intent, calls } = makeFakeIntent([questionsResult])
    const intakeService = createIntake({
      intent,
      runMission: async () => {},
      eligibleSkills: () => [],
      beginActivity: () => () => {},
      onError: () => {},
    })

    const attachments = [file('mockup.png', png)]
    const intake = await intakeService.submit(repoDir, 'Criar painel com tela de login', attachments)

    expect(calls).toHaveLength(1)
    const expectedAttachmentPath = path.resolve(repoDir, '.ade', 'missions', intake.mission_id, 'attachments', 'mockup.png')

    // O pedido repassado à porta de intenção deve conter o bloco 'Anexos do pedido (referência)'
    expect(calls[0].request).toContain('Anexos do pedido (referência)')
    // Deve citar o caminho absoluto dentro da pasta attachments da missão
    expect(calls[0].request).toContain(expectedAttachmentPath)
    expect(calls[0].request).toContain('mockup.png')

    // Sem gravar essa mudança no intake.json
    const diskIntake = JSON.parse(fs.readFileSync(path.join(repoDir, '.ade', 'missions', intake.mission_id, 'intake.json'), 'utf8'))
    expect(diskIntake.request).toBe('Criar painel com tela de login')
    expect(diskIntake.request).not.toContain('Anexos do pedido (referência)')
  })

  test('C2.2 dado um pedido com anexos que passou pela entrevista ou pelo briefing, com a porta dublê, quando a porta é chamada de novo para montar o plano, então o que ela recebe (pedido ou entendimento) ainda cita os caminhos dos anexos', async () => {
    const { plan, contracts } = makePlanAndContracts()
    const { intent, calls } = makeFakeIntent([questionsResult, { plan, contracts }])
    const intakeService = createIntake({
      intent,
      runMission: async () => {},
      eligibleSkills: () => [],
      beginActivity: () => () => {},
      onError: () => {},
    })

    const attachments = [file('mockup.png', png)]
    const intake = await intakeService.submit(repoDir, 'Criar painel com tela de login', attachments)
    expect(intake.stage).toBe('interview')

    // Responde à entrevista para avançar para a montagem do plano
    await intakeService.answer(repoDir, { q1: 'opt_dark' })

    expect(calls).toHaveLength(2)
    const expectedAttachmentPath = path.resolve(repoDir, '.ade', 'missions', intake.mission_id, 'attachments', 'mockup.png')

    // Na chamada para montar o plano, o pedido ou o entendimento repassado ainda cita o caminho do anexo e o bloco
    const secondCall = calls[1]
    const requestCitesAttachment = secondCall.request.includes('Anexos do pedido (referência)') && secondCall.request.includes(expectedAttachmentPath)
    const understandingCitesAttachment = (secondCall.understanding?.summary ?? '').includes('Anexos do pedido (referência)') && (secondCall.understanding?.summary ?? '').includes(expectedAttachmentPath)

    expect(requestCitesAttachment || understandingCitesAttachment).toBe(true)

    // E essa mudança não pode ter sido gravada no intake.json
    const diskIntake = JSON.parse(fs.readFileSync(path.join(repoDir, '.ade', 'missions', intake.mission_id, 'intake.json'), 'utf8'))
    expect(diskIntake.request).toBe('Criar painel com tela de login')
    expect(diskIntake.request).not.toContain('Anexos do pedido (referência)')
    if (diskIntake.understanding?.summary) {
      expect(diskIntake.understanding.summary).not.toContain('Anexos do pedido (referência)')
    }
  })

  test('C2.3 dado um pedido com anexos cujo dublê devolve um plano com contratos, quando o plano é gravado na missão, então a tarefa de cada contrato em stories/*.json cita os caminhos dos anexos, e o plano continua válido', async () => {
    const { plan, contracts } = makePlanAndContracts()
    const { intent } = makeFakeIntent([{ plan, contracts }])
    const intakeService = createIntake({
      intent,
      runMission: async () => {},
      eligibleSkills: () => [],
      beginActivity: () => () => {},
      onError: () => {},
    })

    const attachments = [file('mockup.png', png)]
    const intake = await intakeService.submit(repoDir, 'Criar painel direto para plano', attachments)
    expect(intake.stage).toBe('plan')

    const expectedAttachmentPath = path.resolve(repoDir, '.ade', 'missions', intake.mission_id, 'attachments', 'mockup.png')
    const contractPath = path.join(repoDir, '.ade', 'missions', intake.mission_id, 'stories', 'S1.json')
    expect(fs.existsSync(contractPath)).toBe(true)

    const diskContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    // A tarefa de cada contrato em stories/*.json cita os caminhos dos anexos
    expect(diskContract.task).toContain('Anexos do pedido (referência)')
    expect(diskContract.task).toContain(expectedAttachmentPath)
    expect(diskContract.task).toContain('mockup.png')
    expect(diskContract.task).toContain('Renderizar gráficos no painel')

    // E o plano gravado continua válido
    const planPath = path.join(repoDir, '.ade', 'missions', intake.mission_id, 'plan.json')
    const validation = validateMissionPlan(planPath)
    expect(validation.valid).toBe(true)
  })

  test('C2.4 dado um pedido com anexos que chegou ao briefing, quando o briefing é aprovado pelo digest, então o briefing gravado em briefing.json é igual ao aprovado, sem a lista de anexos, e a aprovação não falha por digest', async () => {
    const { plan, contracts } = makePlanAndContracts()
    const { intent } = makeFakeIntent([briefingResult, { plan, contracts }])
    const intakeService = createIntake({
      intent,
      runMission: async () => {},
      eligibleSkills: () => [],
      beginActivity: () => () => {},
      onError: () => {},
    })

    const attachments = [file('mockup.png', png)]
    const intake = await intakeService.submit(repoDir, 'Projeto grande que gera briefing', attachments)
    expect(intake.stage).toBe('briefing')
    expect(intake.digest).toBeDefined()

    // Aprova o briefing pelo digest
    const approved = await intakeService.approveBriefing(repoDir, intake.digest)
    expect(approved.stage).toBe('plan')

    // O briefing gravado em briefing.json é igual ao aprovado, sem a lista de anexos
    const briefingPath = path.join(repoDir, '.ade', 'missions', intake.mission_id, 'briefing.json')
    expect(fs.existsSync(briefingPath)).toBe(true)
    const diskBriefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8'))
    expect(diskBriefing).toEqual(sampleBriefing)
    expect(JSON.stringify(diskBriefing)).not.toContain('Anexos do pedido (referência)')
    expect(JSON.stringify(diskBriefing)).not.toContain('mockup.png')
  })

  test('C2.5 dado um pedido sem anexos, quando o fluxo segue da entrevista ao plano, então o pedido, o entendimento e as tarefas repassados à IA são os mesmos de hoje', async () => {
    const { plan, contracts } = makePlanAndContracts()
    const { intent, calls } = makeFakeIntent([questionsResult, { plan, contracts }])
    const intakeService = createIntake({
      intent,
      runMission: async () => {},
      eligibleSkills: () => [],
      beginActivity: () => () => {},
      onError: () => {},
    })

    // Envio sem anexos
    const intake = await intakeService.submit(repoDir, 'Pedido simples sem anexos')
    expect(intake.stage).toBe('interview')
    expect(calls).toHaveLength(1)
    expect(calls[0].request).toBe('Pedido simples sem anexos')
    expect(calls[0].request).not.toContain('Anexos do pedido (referência)')

    // Responde à entrevista
    await intakeService.answer(repoDir, { q1: 'opt_dark' })
    expect(calls).toHaveLength(2)

    // O que a IA recebe continua igual a hoje, sem bloco de anexos
    expect(calls[1].request).toBe('Pedido simples sem anexos')
    expect(calls[1].request).not.toContain('Anexos do pedido (referência)')
    expect(calls[1].understanding?.summary).toBe(questionsResult.understanding?.summary)
    expect(calls[1].understanding?.summary).not.toContain('Anexos do pedido (referência)')

    // Tarefas nos contratos não contêm menção a anexos
    const contractPath = path.join(repoDir, '.ade', 'missions', intake.mission_id, 'stories', 'S1.json')
    const diskContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    expect(diskContract.task).toBe('Renderizar gráficos no painel')
    expect(diskContract.task).not.toContain('Anexos do pedido (referência)')
  })
})
