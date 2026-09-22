import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { validate, validateSupported } from '../src/schema/index.js'
import { loadPlan } from '../src/engine/plan-load.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHARTER_PATH = path.join(ROOT, 'PROJECT_CHARTER.md')
const ADR_README_PATH = path.join(ROOT, 'docs/adr/README.md')
const ADR_0024_PATH = path.join(ROOT, 'docs/adr/0024-autorizacao-roadmap-ate-v1.md')

const VALID_V03_CONTRACT = {
  format_version: 2,
  id: 'ADE-S1',
  title: 'Ativar governança e contratos v0.3',
  complexity: 'bounded',
  needs_ui: false,
  task: 'Publicar os contratos v0.3 e carregador ajv.',
  workspace: {
    kind: 'git',
    root: '.',
    revision: '01dc2ec',
  },
  risk: {
    level: 'normal',
    surfaces: [] as string[],
    evidence: [] as string[],
  },
  guardrails: {
    scope_paths: ['schemas/**', 'src/schema/**'],
    do_not_touch: ['.ade/**', 'proto/**'],
    autonomy: 'safe',
  },
  requirements: [
    {
      id: 'R1',
      ears: 'WHEN contrato for validado THE SYSTEM SHALL aceitar formato v0.3.',
    },
  ],
  scenarios: [
    Object.assign(
      {
        id: 'C1',
        given: 'contrato v0.3',
        when: 'ajv valida',
        verifiers: ['V1'],
      },
      JSON.parse('{"then":"aceita como válido"}'),
    ),
  ],
  verifiers: [
    {
      id: 'V1',
      kind: 'script',
      cmd: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/task-contract-v03.test.ts'],
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 65536,
      evidence: ['tests/task-contract-v03.test.ts'],
      strictness: {
        mode: 'must_fail_before',
      },
      author: 'operator',
    },
  ],
  skills: [],
  roles: {
    maker: {
      family: 'claude',
      model_id: 'claude-sonnet-5',
    },
    checker_round: {
      family: 'codex',
      model_id: 'codex-1',
    },
  },
  budget: {
    max_model_calls: 6,
    max_rework_rounds: 2,
  },
  research_refs: [],
}

const VALID_V03_PLAN = {
  format_version: 2,
  id: 'plan-v03',
  mission_id: 'mission-v03',
  immutable_digest: '0123456789abcdef',
  authorization: {
    autonomy: 'safe',
    permitted_effects: [],
    eligible_skills: [],
  },
  phases: [
    {
      epics: [
        {
          stories: ['ADE-S1'],
        },
      ],
    },
  ],
  mission_budget: {
    max_usd: 20,
    max_wall_clock_seconds: 28800,
    max_parked_units: 3,
    max_subscription_weekly_percent: 50,
  },
  budget: {
    max_model_calls: 6,
    max_rework_rounds: 2,
  },
}

const VALID_ARTIFACT = {
  ref: 'repo-ir-0123456789abcdef',
  kind: 'repo_ir',
  digest: 'abcdef0123456789',
  producer: 'repo-discovery',
  producer_version: '0.3.0',
  input_digest: '0123456789abcdef',
  created_at: '2026-09-20T14:00:00Z',
  provenance: ['commit:01dc2ec'],
  confidence: 0.95,
}

describe('v0.3 Acceptance Criteria', () => {
  test('criterio_1_carta_identifica_v03_como_recorte_ativo_apontando_adr_0024', () => {
    expect(existsSync(CHARTER_PATH)).toBe(true)
    const charter = readFileSync(CHARTER_PATH, 'utf8')

    // Carta identifica a v0.3 (ou v0.5 ou v1 ativo) como recorte ativo
    expect(charter).toMatch(/Recorte ativo(?: de governança)? (?:da )?(?:v0\.[35]|v1)/i)

    // Aponta para o ADR 0024
    expect(charter).toContain('0024-autorizacao-roadmap-ate-v1.md')

    // ADR 0024 existe e não foi duplicado
    expect(existsSync(ADR_0024_PATH)).toBe(true)
    const adrReadme = readFileSync(ADR_README_PATH, 'utf8')
    expect(adrReadme).toContain('0024-autorizacao-roadmap-ate-v1.md')

    // Não há ADR 0024 duplicado
    const adrFiles = [
      'docs/adr/0024b.md',
      'docs/adr/0024-autorizacao-v03.md',
      'docs/adr/0027-autorizacao.md',
    ]
    for (const f of adrFiles) {
      expect(existsSync(path.join(ROOT, f))).toBe(false)
    }
  })

  test('criterio_2_contrato_sem_complexidade_escopo_protecao_risco_ou_verificador_por_cenario_e_recusado', () => {
    // Caso válido deve ser aceito
    const validRes = validate('task-contract', VALID_V03_CONTRACT)
    expect(validRes.valid).toBe(true)

    // Sem complexidade
    const noComplexity = { ...VALID_V03_CONTRACT }
    delete (noComplexity as any).complexity
    const resComplexity = validate('task-contract', noComplexity)
    expect(resComplexity.valid).toBe(false)
    if (!resComplexity.valid) {
      expect(resComplexity.code).toBe(4)
      expect(resComplexity.errors.some((e) => e.path.includes('complexity'))).toBe(true)
    }

    // Sem escopo (guardrails.scope_paths)
    const noScope = structuredClone(VALID_V03_CONTRACT)
    delete (noScope.guardrails as any).scope_paths
    const resScope = validate('task-contract', noScope)
    expect(resScope.valid).toBe(false)
    if (!resScope.valid) {
      expect(resScope.code).toBe(4)
      expect(resScope.errors.some((e) => e.path.includes('scope_paths'))).toBe(true)
    }

    // Sem proteção de caminhos (guardrails.do_not_touch)
    const noProtection = structuredClone(VALID_V03_CONTRACT)
    delete (noProtection.guardrails as any).do_not_touch
    const resProtection = validate('task-contract', noProtection)
    expect(resProtection.valid).toBe(false)
    if (!resProtection.valid) {
      expect(resProtection.code).toBe(4)
      expect(resProtection.errors.some((e) => e.path.includes('do_not_touch'))).toBe(true)
    }

    // Sem risco
    const noRisk = { ...VALID_V03_CONTRACT }
    delete (noRisk as any).risk
    const resRisk = validate('task-contract', noRisk)
    expect(resRisk.valid).toBe(false)
    if (!resRisk.valid) {
      expect(resRisk.code).toBe(4)
      expect(resRisk.errors.some((e) => e.path.includes('risk'))).toBe(true)
    }

    // Sem verificador para o cenário (campo ausente)
    const noVerifierScenario = structuredClone(VALID_V03_CONTRACT)
    delete (noVerifierScenario.scenarios[0] as any).verifiers
    delete (noVerifierScenario.scenarios[0] as any).evals
    const resNoVerifier = validate('task-contract', noVerifierScenario)
    expect(resNoVerifier.valid).toBe(false)
    if (!resNoVerifier.valid) {
      expect(resNoVerifier.code).toBe(4)
      expect(resNoVerifier.errors.some((e) => e.path.includes('scenarios'))).toBe(true)
    }

    // Verificadores vazios no cenário
    const emptyVerifierScenario = structuredClone(VALID_V03_CONTRACT)
    emptyVerifierScenario.scenarios[0].verifiers = []
    const resEmptyVerifier = validate('task-contract', emptyVerifierScenario)
    expect(resEmptyVerifier.valid).toBe(false)
    if (!resEmptyVerifier.valid) {
      expect(resEmptyVerifier.code).toBe(4)
      expect(resEmptyVerifier.errors.some((e) => e.path.includes('scenarios'))).toBe(true)
    }

    // Lista superior de verificadores vazia
    const emptyTopVerifiers = structuredClone(VALID_V03_CONTRACT)
    emptyTopVerifiers.verifiers = []
    const resEmptyTop = validate('task-contract', emptyTopVerifiers)
    expect(resEmptyTop.valid).toBe(false)
    if (!resEmptyTop.valid) {
      expect(resEmptyTop.code).toBe(4)
      expect(resEmptyTop.errors.some((e) => e.path.includes('verifiers'))).toBe(true)
    }

    // Verificador sem id
    const missingVerifierId = structuredClone(VALID_V03_CONTRACT)
    delete (missingVerifierId.verifiers[0] as any).id
    const resMissingId = validate('task-contract', missingVerifierId)
    expect(resMissingId.valid).toBe(false)
    if (!resMissingId.valid) {
      expect(resMissingId.code).toBe(4)
      expect(resMissingId.errors.some((e) => e.path.includes('verifiers'))).toBe(true)
    }

    // Identificador de verificador duplicado
    const duplicateVerifierId = structuredClone(VALID_V03_CONTRACT)
    duplicateVerifierId.verifiers.push({ ...duplicateVerifierId.verifiers[0] })
    const resDuplicateId = validate('task-contract', duplicateVerifierId)
    expect(resDuplicateId.valid).toBe(false)
    if (!resDuplicateId.valid) {
      expect(resDuplicateId.code).toBe(4)
      expect(resDuplicateId.errors.some((e) => e.path.includes('verifiers'))).toBe(true)
    }

    // Cenário referencia verificador inexistente
    const unrefScenario = structuredClone(VALID_V03_CONTRACT)
    unrefScenario.scenarios[0].verifiers = ['V_INEXISTENTE']
    const resUnref = validate('task-contract', unrefScenario)
    expect(resUnref.valid).toBe(false)
    if (!resUnref.valid) {
      expect(resUnref.code).toBe(4)
      expect(resUnref.errors.some((e) => e.path.includes('verifiers'))).toBe(true)
    }
  })

  test('criterio_3_superficie_sensivel_exige_evidencia_e_recusa_caminho_leve', () => {
    const sensitiveSurfaces = [
      'auth',
      'secrets',
      'money',
      'billing',
      'migration',
      'data_loss',
      'agent_control_plane',
    ]

    for (const surface of sensitiveSurfaces) {
      // Superfície sensível com caminho leve (light) é recusada
      const contractLight = structuredClone(VALID_V03_CONTRACT)
      contractLight.risk = {
        level: 'light',
        surfaces: [surface],
        evidence: ['repo:src/auth.js'],
      }
      const resLight = validate('task-contract', contractLight)
      expect(resLight.valid, `superfície ${surface} com level light deve ser recusada`).toBe(false)
      if (!resLight.valid) {
        expect(resLight.code).toBe(4)
        expect(
          resLight.errors.some((e) => e.path.includes('risk') || e.path.includes('level')),
        ).toBe(true)
      }

      // Superfície sensível sem evidências rastreáveis é recusada
      const contractNoEvidence = structuredClone(VALID_V03_CONTRACT)
      contractNoEvidence.risk = {
        level: 'critical',
        surfaces: [surface],
        evidence: [],
      }
      const resNoEvidence = validate('task-contract', contractNoEvidence)
      expect(resNoEvidence.valid, `superfície ${surface} sem evidência deve ser recusada`).toBe(false)
      if (!resNoEvidence.valid) {
        expect(resNoEvidence.code).toBe(4)
        expect(
          resNoEvidence.errors.some((e) => e.path.includes('evidence')),
        ).toBe(true)
      }

      // Superfície sensível com evidências rastreáveis e nível não-leve é aceita
      const contractValid = structuredClone(VALID_V03_CONTRACT)
      contractValid.risk = {
        level: 'critical',
        surfaces: [surface],
        evidence: [`repo:src/${surface}.js`, 'requirement:R1'],
      }
      const resValid = validate('task-contract', contractValid)
      expect(resValid.valid, `superfície ${surface} com evidência e nível critical deve ser aceita`).toBe(true)
    }

    // Evidência vazia ("") é recusada
    const contractEmptyEvidence = structuredClone(VALID_V03_CONTRACT)
    contractEmptyEvidence.risk = {
      level: 'critical',
      surfaces: ['auth'],
      evidence: [''],
    }
    const resEmptyEv = validate('task-contract', contractEmptyEvidence)
    expect(resEmptyEv.valid).toBe(false)
    if (!resEmptyEv.valid) {
      expect(resEmptyEv.code).toBe(4)
      expect(resEmptyEv.errors.some((e) => e.path.includes('evidence'))).toBe(true)
    }

    // Evidência sem formato rastreável (sem prefixo:id) é recusada
    const contractInvalidEv = structuredClone(VALID_V03_CONTRACT)
    contractInvalidEv.risk = {
      level: 'critical',
      surfaces: ['auth'],
      evidence: ['apenas um texto qualquer sem prefixo'],
    }
    const resInvalidEv = validate('task-contract', contractInvalidEv)
    expect(resInvalidEv.valid).toBe(false)
    if (!resInvalidEv.valid) {
      expect(resInvalidEv.code).toBe(4)
      expect(resInvalidEv.errors.some((e) => e.path.includes('evidence'))).toBe(true)
    }

    // Superfície desconhecida é recusada
    const contractUnknownSurface = structuredClone(VALID_V03_CONTRACT)
    contractUnknownSurface.risk = {
      level: 'normal',
      surfaces: ['superficie_inventada_nao_canonica'],
      evidence: ['repo:src/app.js'],
    }
    const resUnknownSurf = validate('task-contract', contractUnknownSurface)
    expect(resUnknownSurf.valid).toBe(false)
    if (!resUnknownSurf.valid) {
      expect(resUnknownSurf.code).toBe(4)
      expect(resUnknownSurf.errors.some((e) => e.path.includes('surfaces'))).toBe(true)
    }
  })

  test('criterio_4_verificador_script_schema_judge_human_external_aceita_somente_campos_compativeis', () => {
    // 0. kind: 'test' é recusado na v0.3
    const testKindVer = {
      id: 'V0',
      kind: 'test',
      cmd: ['node', 'test.mjs'],
      expect_exit: 0,
    }
    const resTestKind = validate('verifier', testKindVer)
    expect(resTestKind.valid).toBe(false)
    if (!resTestKind.valid) {
      expect(resTestKind.code).toBe(4)
    }

    // 1. script: aceita cmd, expect_exit, timeout_s; recusa campos de outras classes como rubric
    const scriptVer = {
      id: 'V1',
      kind: 'script',
      cmd: ['node', 'test.mjs'],
      expect_exit: 0,
      timeout_s: 30,
      max_output_bytes: 65536,
      evidence: ['test.mjs'],
      strictness: {
        mode: 'must_fail_before',
      },
      author: 'operator',
    }
    expect(validate('verifier', scriptVer).valid).toBe(true)

    const invalidScript = { ...scriptVer, rubric: 'qualidade visual >= 4' }
    const resInvalidScript = validate('verifier', invalidScript)
    expect(resInvalidScript.valid).toBe(false)
    if (!resInvalidScript.valid) {
      expect(resInvalidScript.code).toBe(4)
      expect(resInvalidScript.errors.some((e) => e.path.includes('rubric'))).toBe(true)
    }

    // 2. schema: aceita schema_path/schema_ref, target_path/target; recusa cmd
    const schemaVer = {
      id: 'V2',
      kind: 'schema',
      schema_path: 'schemas/task-contract.schema.json',
      target_path: 'contract.json',
    }
    expect(validate('verifier', schemaVer).valid).toBe(true)

    const invalidSchema = { ...schemaVer, cmd: ['node', 'validate.mjs'] }
    const resInvalidSchema = validate('verifier', invalidSchema)
    expect(resInvalidSchema.valid).toBe(false)
    if (!resInvalidSchema.valid) {
      expect(resInvalidSchema.code).toBe(4)
      expect(resInvalidSchema.errors.some((e) => e.path.includes('cmd'))).toBe(true)
    }

    // 3. judge: aceita rubric, threshold, model; recusa cmd
    const judgeVer = {
      id: 'V3',
      kind: 'judge',
      rubric: 'acessibilidade WCAG AA sem violações',
      threshold: 0.8,
      model: 'claude-sonnet-5',
    }
    expect(validate('verifier', judgeVer).valid).toBe(true)

    const invalidJudge = { ...judgeVer, cmd: ['run-judge'] }
    const resInvalidJudge = validate('verifier', invalidJudge)
    expect(resInvalidJudge.valid).toBe(false)
    if (!resInvalidJudge.valid) {
      expect(resInvalidJudge.code).toBe(4)
      expect(resInvalidJudge.errors.some((e) => e.path.includes('cmd'))).toBe(true)
    }

    // 4. human: aceita prompt/instructions, options, timeout_s; recusa expect_exit
    const humanVer = {
      id: 'V4',
      kind: 'human',
      prompt: 'Aprovar resultado visual da landing page',
      options: ['aprovar', 'rejeitar'],
      timeout_s: 300,
    }
    expect(validate('verifier', humanVer).valid).toBe(true)

    const invalidHuman = { ...humanVer, expect_exit: 0 }
    const resInvalidHuman = validate('verifier', invalidHuman)
    expect(resInvalidHuman.valid).toBe(false)
    if (!resInvalidHuman.valid) {
      expect(resInvalidHuman.code).toBe(4)
      expect(resInvalidHuman.errors.some((e) => e.path.includes('expect_exit'))).toBe(true)
    }

    // 5. external: aceita service/endpoint, timeout_s; recusa rubric
    const externalVer = {
      id: 'V5',
      kind: 'external',
      service: 'https://api.external.com/health',
      timeout_s: 60,
    }
    expect(validate('verifier', externalVer).valid).toBe(true)

    const invalidExternal = { ...externalVer, rubric: 'deve ser rápido' }
    const resInvalidExternal = validate('verifier', invalidExternal)
    expect(resInvalidExternal.valid).toBe(false)
    if (!resInvalidExternal.valid) {
      expect(resInvalidExternal.code).toBe(4)
      expect(resInvalidExternal.errors.some((e) => e.path.includes('rubric'))).toBe(true)
    }
  })

  test('criterio_5_artefato_certificado_exige_campos_obrigatorios_e_recusa_desconhecidos', () => {
    // Válido
    const validRes = validate('artifact', VALID_ARTIFACT)
    expect(validRes.valid).toBe(true)

    // Campos obrigatórios: ref, kind, digest, producer, producer_version, input_digest, created_at, provenance, confidence
    const requiredFields = [
      'ref',
      'kind',
      'digest',
      'producer',
      'producer_version',
      'input_digest',
      'created_at',
      'provenance',
      'confidence',
    ]

    for (const field of requiredFields) {
      const incomplete = { ...VALID_ARTIFACT }
      delete (incomplete as any)[field]
      const res = validate('artifact', incomplete)
      expect(res.valid, `campo obrigatório ausente: ${field}`).toBe(false)
      if (!res.valid) {
        expect(res.code).toBe(4)
        expect(res.errors.some((e) => e.path.includes(field))).toBe(true)
      }
    }

    // Campo desconhecido é recusado
    const withUnknown = {
      ...VALID_ARTIFACT,
      __unexpected__: 'valor proibido',
    }
    const resUnknown = validate('artifact', withUnknown)
    expect(resUnknown.valid).toBe(false)
    if (!resUnknown.valid) {
      expect(resUnknown.code).toBe(4)
      expect(resUnknown.errors.some((e) => e.path.includes('__unexpected__'))).toBe(true)
    }
  })

  test('criterio_6_formato_historico_legivel_em_leitura_e_recusado_como_obsoleto_em_nova_aprovacao', () => {
    const legacyPlanV1 = {
      format_version: 1,
      id: 'plan-legacy',
      mission_id: 'mission-legacy',
      immutable_digest: '0123456789abcdef',
      authorization: {
        autonomy: 'safe',
        permitted_effects: [],
        eligible_skills: [],
      },
      phases: [
        {
          epics: [
            {
              stories: [],
            },
          ],
        },
      ],
      mission_budget: {
        max_usd: 10,
      },
      budget: {
        max_model_calls: 6,
        max_rework_rounds: 2,
      },
    }

    // 1. Em modo de leitura, plano histórico permanece legível (valid: true, current: false)
    const readResult = validateSupported('plan', legacyPlanV1)
    expect(readResult.valid).toBe(true)
    expect(readResult.current).toBe(false)
    expect(readResult.formatVersion).toBe(1)

    // loadPlan em modo de leitura abre o plano histórico
    const loadedRead = loadPlan(legacyPlanV1, { mode: 'read' })
    expect(loadedRead).toBeDefined()
    expect(loadedRead.plan.id).toBe('plan-legacy')

    // 2. Quando apresentado para nova aprovação / execução corrente, é recusado como obsoleto
    const approvalValidation = validate('plan', legacyPlanV1)
    expect(approvalValidation.valid).toBe(false)
    if (!approvalValidation.valid) {
      expect(approvalValidation.code).toBe(4)
      expect(
        approvalValidation.errors.some(
          (e) => e.path.includes('format_version') || e.message.includes('obsoleto') || e.code === 'obsolete_format',
        ),
      ).toBe(true)
    }

    // loadPlan para nova aprovação recusa formato legado como obsoleto
    expect(() => loadPlan(legacyPlanV1)).toThrow()
    try {
      loadPlan(legacyPlanV1)
    } catch (err: any) {
      expect(err.exitCode ?? err.code).toBe(4)
      expect(err.message).toMatch(/obsoleto/i)
    }
  })

  test('criterio_7_expectativas_do_novo_formato_sao_atualizadas_preservando_rejeicoes_anteriores', () => {
    // Novo plano v0.3 é aceito
    const planRes = validate('plan', VALID_V03_PLAN)
    expect(planRes.valid).toBe(true)

    // Novo contrato v0.3 é aceito
    const contractRes = validate('task-contract', VALID_V03_CONTRACT)
    expect(contractRes.valid).toBe(true)

    // Rejeições anteriores preservadas: campos desconhecidos continuam rejeitados com código 4
    const planWithExtra = {
      ...VALID_V03_PLAN,
      __unexpected__: true,
    }
    const resExtra = validate('plan', planWithExtra)
    expect(resExtra.valid).toBe(false)
    if (!resExtra.valid) {
      expect(resExtra.code).toBe(4)
      expect(resExtra.errors.some((e) => e.path.includes('__unexpected__'))).toBe(true)
    }

    // Rejeição de orçamento acima do teto de US$ 300 preservada
    const planExcessBudget = structuredClone(VALID_V03_PLAN)
    planExcessBudget.mission_budget.max_usd = 350
    expect(() => loadPlan(planExcessBudget)).toThrow()
  })
})
