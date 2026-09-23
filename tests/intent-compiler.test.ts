import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

import {
  compileIntent,
  classifyIntent,
  buildInterview,
  applyInterviewAnswer,
  splitContract,
  validateCompiledPlan,
  selectEligibleSkills,
  runResearchStep,
} from '../src/intent/compiler.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function loadJson(relPath: string) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'))
}

describe('v0.3 Intent Compiler Acceptance Criteria', () => {
  test('criterio_1_correcao_em_um_arquivo_classificada_como_trivial_sem_chamar_modelo', async () => {
    const fixture = loadJson('fixtures/intent/fast-lane-trivial.json')
    const advisorSpy = vi.fn()

    const result = await classifyIntent(
      {
        request: fixture.request,
        discovery: fixture.discovery,
      },
      advisorSpy,
    )

    expect(result.complexity).toBe('trivial')
    expect(result.source).toBe('deterministic')
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    expect(advisorSpy).not.toHaveBeenCalled()
    expect(result.cost.model_calls).toBe(0)
    expect(result.cost.usd).toBe(0)
  })

  test('criterio_2_baixa_confianca_ou_feature_usa_no_maximo_uma_chamada_injetada_registrando_custo_modelo_e_confianca', async () => {
    const fixture = loadJson('fixtures/intent/feature-advisor.json')
    const advisorSpy = vi.fn().mockResolvedValue(fixture.mock_advisor_response)

    const result = await classifyIntent(
      {
        request: fixture.request,
        discovery: fixture.discovery,
      },
      advisorSpy,
    )

    expect(advisorSpy).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('model')
    expect(result.complexity).toBe('feature')
    expect(result.confidence).toBe(0.85)
    expect(result.cost.model_calls).toBe(1)
    expect(result.cost.usd).toBe(0.015)
    expect(result.cost.model_id).toBe('claude-haiku-4-5')
  })

  test('criterio_3_pergunta_com_resposta_em_discovery_ou_ir_e_recusada_com_referencia_de_evidencia', async () => {
    const fixture = loadJson('fixtures/intent/refused-question.json')

    const questions = buildInterview({
      unknowns: fixture.unknowns,
      discovery: fixture.discovery,
      repoIr: fixture.repoIr,
      maxQuestions: 5,
    })

    // A pergunta sobre o runner de teste já é respondível pelo discovery/IR
    expect(questions.some((q) => q.text.includes('runner de teste'))).toBe(false)
    // Apenas a pergunta indispensável não respondível sobrevive
    expect(questions.some((q) => q.text.includes('timeout padrão'))).toBe(true)

    // Ao compilar o intent completo, a evidência da recusa deve ser registrada
    const compiled = await compileIntent({
      request: fixture.request,
      discovery: fixture.discovery,
      repoIr: fixture.repoIr,
    })

    expect(compiled.refusedQuestions).toBeDefined()
    expect(
      compiled.refusedQuestions.some(
        (r: any) =>
          r.question.includes('runner de teste') &&
          (r.evidence.includes('discovery') || r.evidence.includes('repoIr') || r.evidence.includes('scripts.test')),
      ),
    ).toBe(true)
  })

  test('criterio_4_mais_de_cinco_duvidas_funde_duplicadas_resolve_fatos_e_apresenta_no_maximo_cinco_escolhas', () => {
    const unknowns = [
      { id: 'U1', question: 'Qual o banco de dados principal?', kind: 'repo_fact' },
      { id: 'U2', unknown_ref: 'U2_A', question: 'Qual a moeda padrão do checkout?', kind: 'product_choice' },
      { id: 'U3', unknown_ref: 'U2_A', question: 'Qual moeda aceita no checkout?', kind: 'product_choice' }, // duplicada
      { id: 'U4', question: 'Permitir cupons na primeira compra?', kind: 'product_choice' },
      { id: 'U5', question: 'Habilitar login social com Google?', kind: 'product_choice' },
      { id: 'U6', question: 'Enviar e-mail transacional via SendGrid?', kind: 'product_choice' },
      { id: 'U7', question: 'Exigir autenticação de dois fatores?', kind: 'product_choice' },
      { id: 'U8', question: 'Ativar modo escuro por padrão?', kind: 'product_choice' },
    ]

    const discovery = {
      answerable: ['qual o banco de dados principal'],
      facts: { database: 'postgresql' },
    }

    const questions = buildInterview({
      unknowns,
      discovery,
      maxQuestions: 5,
    })

    // Máximo 5 perguntas
    expect(questions.length).toBeLessThanOrEqual(5)

    // U1 foi resolvida por discovery (answerable)
    expect(questions.some((q) => q.text.toLowerCase().includes('banco de dados'))).toBe(false)

    // U2 e U3 foram fundidas (mesma unknown_ref / tema)
    const currencyQuestions = questions.filter((q) => q.text.toLowerCase().includes('moeda'))
    expect(currencyQuestions.length).toBe(1)

    // Cada pergunta tem recomendação primeiro e opção não sei
    for (const q of questions) {
      expect(q.options.length).toBeGreaterThanOrEqual(2)
      expect(q.options[0].recommended).toBe(true)
      expect(q.options.some((opt) => opt.label.toLowerCase().includes('não sei'))).toBe(true)
    }
  })

  test('criterio_5_resposta_nao_sei_registra_default_recomendado_e_justificativa_mantendo_incognita_rastreavel', () => {
    const fixture = loadJson('fixtures/intent/dont-know.json')
    const initialContract: any = {
      id: 'S1',
      title: 'Configurar relatórios',
      unknowns: [],
    }

    const { contract, decision } = applyInterviewAnswer(
      initialContract,
      fixture.question,
      'dont_know',
    )

    expect(decision.origin).toBe('padrao')
    expect(decision.value).toBe('opt-json')
    expect(decision.rationale).toBe('Padrão de telemetria v0.3')

    // A incógnita permanece rastreável no contrato
    expect(contract.unknowns).toHaveLength(1)
    expect(contract.unknowns[0].id).toBe('U1')
    expect(contract.unknowns[0].resolved_by).toBe('default_assumed')
  })

  test('escopo_da_story_inclui_os_caminhos_do_comando_de_prova_para_o_motor_aceitar_o_verificador', async () => {
    const { contracts } = await compileIntent({ request: 'Mostrar o total de tarefas', discovery: { repo: { head: 'HEAD' }, scripts: { test: 'node --test tests/' }, anchors: [] }, advisor: async () => ({ complexity: 'bounded', confidence: 0.9, domains: ['js'], rationale: 'x' }) })
    expect(contracts[0].verifiers[0].cmd).toEqual(['node', '--test', 'tests/'])
    expect(contracts[0].guardrails.scope_paths).toContain('tests/**')
  })

  test('duvida_aberta_sem_opcoes_nao_ganha_opcoes_de_enfeite_e_aceita_resposta_escrita', () => {
    const [q] = buildInterview({ unknowns: [{ id: 'U1', question: 'Qual o nome do produto?', kind: 'product_choice' }] })

    // Nada de "Padrão recomendado pelo projeto" nem "Opção alternativa configurável": as opções dizem o que acontece.
    expect(q.options.map((o: any) => o.label)).toEqual(['Deixar a TL-ADE decidir', 'Responder com minhas palavras', 'Não sei (a TL-ADE decide)'])
    expect(q.options[1].free_text).toBe(true)

    const { decision } = applyInterviewAnswer({ unknowns: [] }, q, '  Tutti  ', { allowWritten: true })
    expect(decision).toMatchObject({ value: 'Tutti', origin: 'usuario' })

    // Pergunta com opções reais continua recusando resposta fora delas.
    const [closed] = buildInterview({ unknowns: [{ id: 'U2', question: 'Formato?', options: [{ id: 'a', label: 'A' }] }] })
    expect(() => applyInterviewAnswer({ unknowns: [] }, closed, 'texto livre', { allowWritten: true })).toThrow(/opção inexistente/)
    // Sem a permissão (arquivo de respostas da CLI), texto fora das opções segue recusado mesmo em dúvida aberta.
    expect(() => applyInterviewAnswer({ unknowns: [] }, q, 'Tutti')).toThrow(/opção inexistente/)
  })

  test('criterio_6_incognita_externa_com_pesquisa_permitida_produz_fonte_data_e_artefato_ou_default_reversivel', async () => {
    const fixture = loadJson('fixtures/intent/research-external.json')
    const mockResearcher = vi.fn().mockResolvedValue(fixture.mock_researcher_result)

    // Com pesquisa permitida
    const artifact = await runResearchStep({
      unknown: fixture.unknown,
      budget: fixture.budget,
      researcher: mockResearcher,
    })

    expect(mockResearcher).toHaveBeenCalledTimes(1)
    expect(artifact.kind).toBe('research_finding')
    expect(artifact.ref).toMatch(/^research-finding:/)
    expect(artifact.digest).toBeDefined()
    expect(artifact.created_at).toBeDefined()
    expect(artifact.provenance).toContain('https://stripe.com/docs/api/subscriptions')

    // Sem pesquisa permitida pela política -> usa default reversível
    const noResearchResult = await runResearchStep({
      unknown: fixture.unknown,
      budget: fixture.budget,
      policy: { allow_research: false },
      researcher: mockResearcher,
    })
    expect(noResearchResult.data?.fallback_applied).toBe(true)
  })

  test('criterio_7_pedido_amplo_registra_direcao_proxima_entrega_e_somente_trabalho_executavel_agora', async () => {
    const fixture = loadJson('fixtures/intent/progressive-request.json')

    const { briefing, plan, contracts } = await compileIntent({
      request: fixture.request,
      discovery: fixture.discovery,
    })

    expect(briefing.direction).toBeDefined()
    expect(briefing.next_delivery).toBeDefined()
    expect(plan.direction).toBeDefined()
    expect(plan.next_delivery).toBeDefined()
    expect(plan.intent).toBe(fixture.request)

    // Somente o trabalho executável agora entra em contracts/fase inicial
    expect(contracts.length).toBeGreaterThan(0)
    expect(contracts.length).toBe(4) // sem teto fixo: as 4 entregas do pedido viram stories
    expect(plan.phases[0].epics[0].stories).toHaveLength(contracts.length)
  })

  test('criterio_8_divisao_de_contrato_com_cenarios_independentes_e_pura_estavel_e_conserva_cobertura', () => {
    const fixture = loadJson('fixtures/intent/split-needed.json')
    const originalContract = fixture.contract

    const limits = { max_scenarios: 1, max_contract_bytes: 32000 }
    const split1 = splitContract(originalContract, limits)
    const split2 = splitContract(originalContract, limits)

    // Função pura e estável
    expect(split1).toEqual(split2)
    expect(split1).toHaveLength(2)

    // Cobertura conservada: todos os cenários e requisitos preservados
    const allScenarios = split1.flatMap((c) => c.scenarios)
    expect(allScenarios.map((s) => s.id)).toEqual(['C1', 'C2'])

    const allVerifiers = split1.flatMap((c) => c.verifiers)
    expect(allVerifiers.map((v) => v.id)).toEqual(['V1', 'V2'])

    // Nenhuma dependência cíclica ou artificial
    for (const c of split1) {
      expect(c.guardrails.do_not_touch).toEqual(originalContract.guardrails.do_not_touch)
      expect(c.complexity).toBe(originalContract.complexity)
    }
  })

  test('criterio_9_story_sem_verificador_sem_do_not_touch_sem_classe_ou_com_ui_sem_briefing_e_recusada', () => {
    const validPlan = {
      format_version: 2,
      id: 'plan-test',
      mission_id: 'mission-test',
      immutable_digest: 'abcdef0123456789',
      authorization: {
        autonomy: 'safe',
        permitted_effects: [],
        eligible_skills: [],
      },
      phases: [{ epics: [{ stories: ['S1'] }] }],
      mission_budget: { max_usd: 10 },
      budget: { max_model_calls: 3, max_rework_rounds: 1 },
    }

    const baseContract = {
      format_version: 2,
      id: 'S1',
      title: 'Story válida',
      complexity: 'trivial',
      needs_ui: false,
      task: 'Executar tarefa de teste',
      workspace: { kind: 'git', root: '.', revision: '01dc2ec' },
      risk: { level: 'normal', surfaces: [], evidence: [] },
      guardrails: {
        scope_paths: ['src/**'],
        do_not_touch: ['.ade/**'],
        autonomy: 'safe',
      },
      requirements: [
        { id: 'R1', ears: 'WHEN event happens THE SYSTEM SHALL return true within 1 s' },
      ],
      scenarios: [
        Object.assign(
          { id: 'C1', given: 'init', when: 'event', verifiers: ['V1'] },
          JSON.parse('{"then":"true"}'),
        ),
      ],
      verifiers: [
        {
          id: 'V1',
          kind: 'script',
          cmd: ['node', 'test.js'],
          expect_exit: 0,
          timeout_s: 30,
          max_output_bytes: 1024,
          evidence: ['test.js'],
          strictness: { mode: 'must_fail_before' },
          author: 'operator',
        },
      ],
      skills: [],
      roles: {
        maker: { family: 'claude', model_id: 'claude-sonnet-5' },
        checker_round: { family: 'codex', model_id: 'codex-1' },
      },
      budget: { max_model_calls: 3, max_rework_rounds: 1 },
    }

    // Caso base válido
    const validRes = validateCompiledPlan(validPlan, [baseContract])
    expect(validRes.valid).toBe(true)

    // Sem verificador por cenário
    const noVerifierContract = structuredClone(baseContract)
    noVerifierContract.scenarios[0].verifiers = []
    expect(validateCompiledPlan(validPlan, [noVerifierContract]).valid).toBe(false)

    // Sem do_not_touch
    const noDoNotTouchContract = structuredClone(baseContract)
    noDoNotTouchContract.guardrails.do_not_touch = []
    expect(validateCompiledPlan(validPlan, [noDoNotTouchContract]).valid).toBe(false)

    // Sem classe de complexidade
    const noComplexityContract = structuredClone(baseContract)
    delete (noComplexityContract as any).complexity
    expect(validateCompiledPlan(validPlan, [noComplexityContract]).valid).toBe(false)

    // UI sem design_brief
    const uiWithoutBriefContract = structuredClone(baseContract)
    uiWithoutBriefContract.needs_ui = true
    delete (uiWithoutBriefContract as any).design_brief
    expect(validateCompiledPlan(validPlan, [uiWithoutBriefContract]).valid).toBe(false)

    // Requisito genérico (EARS rejeitado)
    const badEarsContract = structuredClone(baseContract)
    badEarsContract.requirements[0].ears = 'THE SYSTEM SHALL work correctly'
    const badEarsRes = validateCompiledPlan(validPlan, [badEarsContract])
    expect(badEarsRes.valid).toBe(false)
    expect(badEarsRes.errors.some((e) => e.code === 'ears_form_rejected')).toBe(true)

    // depends_on com story inexistente
    const missingDepContract: typeof baseContract & { depends_on?: string[] } = structuredClone(baseContract)
    missingDepContract.depends_on = ['NON_EXISTENT_STORY']
    const missingDepRes = validateCompiledPlan(validPlan, [missingDepContract])
    expect(missingDepRes.valid).toBe(false)
    expect(missingDepRes.errors.some((e) => e.code === 'missing_dependency')).toBe(true)

    // depends_on com ciclo
    const cycleContractA: typeof baseContract & { depends_on?: string[] } = structuredClone(baseContract)
    cycleContractA.id = 'S1'
    cycleContractA.depends_on = ['S2']
    const cycleContractB: typeof baseContract & { depends_on?: string[] } = structuredClone(baseContract)
    cycleContractB.id = 'S2'
    cycleContractB.depends_on = ['S1']
    const cyclePlan = structuredClone(validPlan)
    cyclePlan.phases[0].epics[0].stories = ['S1', 'S2']
    const cycleRes = validateCompiledPlan(cyclePlan, [cycleContractA, cycleContractB])
    expect(cycleRes.valid).toBe(false)
    expect(cycleRes.errors.some((e) => e.code === 'dependency_cycle')).toBe(true)
  })

  test('criterio_10_skills_elegiveis_selecionadas_por_dominio_e_linguagem_sem_skills_fora_do_conjunto', () => {
    const catalog = loadJson('fixtures/intent/skills-catalog.json')
    const story = {
      domains: ['api', 'backend'],
      languages: ['typescript'],
      task: 'Criar endpoints REST e serialização de dados',
    }

    const selected = selectEligibleSkills({
      story,
      eligibleSkills: catalog,
    })

    expect(selected).toContain('api-design')
    expect(selected).toContain('backend-patterns')
    expect(selected).not.toContain('frontend-ui')
    expect(selected).not.toContain('database-migration')

    // Nunca recebe skill fora do conjunto elegível
    for (const skillId of selected) {
      expect(catalog.some((s: any) => s.id === skillId)).toBe(true)
    }
  })

  test('criterio_11_superficie_critica_inclui_autorizacao_sensivel_verificador_negativo_ou_recuperacao_e_checker_independente', async () => {
    const fixture = loadJson('fixtures/intent/critical-surface.json')

    const { contracts } = await compileIntent({
      request: fixture.request,
      discovery: fixture.discovery,
    })

    expect(contracts.length).toBeGreaterThan(0)
    const contract = contracts[0]

    // Risco crítico
    expect(contract.risk.level).toBe('critical')
    expect(contract.risk.surfaces).toContain('auth')
    expect(contract.risk.evidence.length).toBeGreaterThan(0)
    for (const ev of contract.risk.evidence) {
      expect(ev).toMatch(/^[a-z0-9_-]+:\S+$/i)
    }

    // Autorização sensível
    expect(contract.guardrails.sensitive_paths).toBeDefined()
    expect(contract.guardrails.sensitive_paths.some((p: string) => p.includes('auth'))).toBe(true)
    expect(contract.guardrails.ask_operator).toBeDefined()

    // Verificador negativo ou de recuperação CORRESPONDENTE à superfície crítica descoberta
    const negative = contract.verifiers.find((v: any) => v.id.includes('neg'))
    expect(negative).toBeDefined()
    expect(negative.strictness.mode).toBe('must_fail_before')
    expect(negative.description).toMatch(/auth/i)
    expect(negative.description).toMatch(/recus|revog|recupera/i)
    expect(negative.cmd.join(' ')).toContain('auth')
    expect(negative.evidence.some((e: string) => e.includes('auth'))).toBe(true)
    // e algum cenário do contrato cobra esse verificador
    expect(contract.scenarios.some((s: any) => s.verifiers.includes(negative.id))).toBe(true)

    // Checker independente (Maker ≠ Checker por model_id e vendor/family)
    expect(contract.roles.maker.model_id).not.toBe(contract.roles.checker_round.model_id)
    expect(contract.roles.maker.family).not.toBe(contract.roles.checker_round.family)
  })

  test('criterio_12_fixtures_compiladas_tres_vezes_permanecem_identicas_em_classe_dominios_divisao_risco_e_verificadores', async () => {
    const fastLane = loadJson('fixtures/intent/fast-lane-trivial.json')
    const critical = loadJson('fixtures/intent/critical-surface.json')

    for (const fixture of [fastLane, critical]) {
      const run1 = await compileIntent({ request: fixture.request, discovery: fixture.discovery })
      const run2 = await compileIntent({ request: fixture.request, discovery: fixture.discovery })
      const run3 = await compileIntent({ request: fixture.request, discovery: fixture.discovery })

      // Classe
      expect(run1.contracts[0].complexity).toBe(run2.contracts[0].complexity)
      expect(run2.contracts[0].complexity).toBe(run3.contracts[0].complexity)

      // Risco
      expect(run1.contracts[0].risk).toEqual(run2.contracts[0].risk)
      expect(run2.contracts[0].risk).toEqual(run3.contracts[0].risk)

      // Verificadores
      expect(run1.contracts[0].verifiers).toEqual(run2.contracts[0].verifiers)
      expect(run2.contracts[0].verifiers).toEqual(run3.contracts[0].verifiers)

      // Divisão
      expect(run1.contracts.length).toBe(run2.contracts.length)
      expect(run2.contracts.length).toBe(run3.contracts.length)
    }
  })
})
