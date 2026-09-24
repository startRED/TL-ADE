import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  blockingReviewFindings,
  buildReviewHandoff,
  testEditViolations,
  wrongTestClaims,
  wrongTestVerdict,
} from '../src/review/contract.ts'
import { validateSupported } from '../src/schema/index.ts'

const CONTRACT = {
  scope_paths: ['src/review/**', 'tests/reviewer_contract.test.ts'],
  do_not_touch: ['proto/**'],
  out_of_scope: ['Seleção do modelo revisor por plano (v3).'],
  interfaces: ['wrongTestVerdict(request) → {allowedPaths: string[]}'],
  decisions: ['O ADR novo é o 0030 e emenda 0023 e 0027'],
}

const DIFF = ['src/review/contract.ts', 'tests/reviewer_contract.test.ts']

function finding(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    severity: 'high',
    category: 'patch',
    target_role: 'maker',
    location: 'src/review/contract.ts:10',
    problem: 'falta validar a citação',
    evidence_refs: ['file:src/review/contract.ts#L1-L10'],
    required_action: 'validar a citação',
    ...over,
  }
}

// revisor dublê: documento de resultado fabricado sobre o fixture válido do schema
function reviewDoc(over: Record<string, unknown> = {}) {
  const base = JSON.parse(readFileSync(new URL('../fixtures/schemas/review-result/valid.json', import.meta.url), 'utf8'))
  return { ...base, verdict: 'changes_requested', requested_action: 'rework', ...over }
}

test('CA1_pedido_ao_revisor_leva_contrato_achados_anteriores_e_resposta_do_maker', () => {
  const makerResponse = 'RECUSADO: f1 - o contrato manda\nPROVA ERRADA: tests/a.test.ts - espera o formato antigo'
  const request = buildReviewHandoff({ contract: CONTRACT, priorFindings: [finding()], makerResponse, diff: DIFF })

  expect(request.scope_paths).toEqual(CONTRACT.scope_paths)
  expect(request.do_not_touch).toEqual(['proto/**'])
  expect(request.out_of_scope).toEqual(['Seleção do modelo revisor por plano (v3).'])
  expect(request.interfaces).toEqual(CONTRACT.interfaces)
  expect(request.decisions).toEqual(CONTRACT.decisions)
  expect(request.prior_findings.map((f) => f.id)).toEqual(['f1'])
  expect(request.maker_response).toEqual({ text: makerResponse, wrong_tests: ['tests/a.test.ts'] })
  expect(request.diff).toEqual(DIFF)
})

test('CA1_borda_contrato_sem_campo_obrigatorio_falha_fechado', () => {
  const { interfaces: _omit, ...partial } = CONTRACT
  expect(() => buildReviewHandoff({ contract: partial as any, priorFindings: [], makerResponse: '', diff: DIFF })).toThrow(/interfaces/)
  expect(() => buildReviewHandoff({ contract: CONTRACT, priorFindings: [], makerResponse: 42 as any, diff: DIFF })).toThrow(/makerResponse/)
})

test('CA2_achado_recusado_com_citacao_valida_sai_dos_bloqueantes_e_inexistente_mantem', () => {
  const request = buildReviewHandoff({ contract: CONTRACT, priorFindings: [finding()], makerResponse: 'RECUSADO: f1', diff: DIFF })
  const withdrawn = (citation: string) =>
    finding({ withdrawn: true, withdrawn_reason: 'maker citou o contrato', citation })

  expect(blockingReviewFindings({ findings: [withdrawn('contract:O ADR novo é o 0030')], request, round: 2 })).toEqual([])
  expect(blockingReviewFindings({ findings: [withdrawn('file:src/review/contract.ts#L3-L9')], request, round: 2 })).toEqual([])

  for (const bad of ['file:src/outro.ts#L1-L2', 'contract:decisão que ninguém tomou', 'nada']) {
    const kept = blockingReviewFindings({ findings: [withdrawn(bad)], request, round: 2 })
    expect(kept.map((f) => f.id)).toEqual(['f1'])
  }
})

test('CA2_schema_de_revisao_aceita_retirada_com_citacao_e_recusa_retirada_sem_citacao', () => {
  const ok = reviewDoc({ action_items: [finding({ withdrawn: true, withdrawn_reason: 'contrato', citation: 'contract:proto/**' })] })
  expect(validateSupported('review-result', ok).valid).toBe(true)
  const semCitacao = reviewDoc({ action_items: [finding({ withdrawn: true, withdrawn_reason: 'contrato' })] })
  expect(validateSupported('review-result', semCitacao).valid).toBe(false)
})

test('CA3_achado_novo_nao_grave_depois_da_primeira_rodada_nao_bloqueia_e_grave_bloqueia', () => {
  const request = buildReviewHandoff({ contract: CONTRACT, priorFindings: [finding()], makerResponse: '', diff: DIFF })
  const novoMedio = finding({ id: 'f2', severity: 'medium', problem: 'nome pouco claro' })
  const novoGrave = finding({ id: 'f3', severity: 'critical', problem: 'apaga trabalho do usuário' })
  const antigoMedio = finding({ severity: 'medium' })

  expect(blockingReviewFindings({ findings: [novoMedio], request, round: 2 })).toEqual([])
  expect(blockingReviewFindings({ findings: [novoGrave], request, round: 2 }).map((f) => f.id)).toEqual(['f3'])
  // achado já levantado antes continua bloqueando mesmo médio
  expect(blockingReviewFindings({ findings: [antigoMedio], request, round: 2 }).map((f) => f.id)).toEqual(['f1'])
  // na primeira rodada todo achado médio é bloqueante
  const first = buildReviewHandoff({ contract: CONTRACT, priorFindings: [], makerResponse: '', diff: DIFF })
  expect(blockingReviewFindings({ findings: [novoMedio], request: first, round: 1 }).map((f) => f.id)).toEqual(['f2'])
})

test('CA4_prova_errada_so_libera_a_prova_com_veredito_favoravel_e_edicao_sem_ele_reprova', () => {
  const claimed = wrongTestClaims('PROVA ERRADA: tests/a.test.ts - formato antigo\nPROVA ERRADA: tests/b.test.ts - data fixa')
  expect(claimed).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])

  const verdicts = [
    { path: 'tests/a.test.ts', agreed: true, reason: 'afirma o formato que a story muda' },
    { path: 'tests/b.test.ts', agreed: false, reason: 'a prova está certa' },
    // veredito sobre prova que o maker não alegou não libera nada
    { path: 'tests/c.test.ts', agreed: true, reason: 'sem pedido' },
  ]
  const { allowedPaths } = wrongTestVerdict({ claimed, verdicts })
  expect(allowedPaths).toEqual(['tests/a.test.ts'])

  expect(testEditViolations({ changedPaths: ['tests/a.test.ts', 'src/x.ts'], claimed, allowedPaths })).toEqual([])
  expect(testEditViolations({ changedPaths: ['tests/b.test.ts', 'src/x.ts'], claimed, allowedPaths })).toEqual(['tests/b.test.ts'])
  // antes do veredito, mexer na prova alegada já reprova
  expect(testEditViolations({ changedPaths: ['tests/a.test.ts'], claimed, allowedPaths: [] })).toEqual(['tests/a.test.ts'])
})

test('CA4_borda_veredito_malformado_falha_fechado_e_schema_aceita_wrong_tests', () => {
  expect(() => wrongTestVerdict({ claimed: ['tests/a.test.ts'], verdicts: [{ path: 'tests/a.test.ts', agreed: 'sim' }] as any })).toThrow(/agreed/)
  const doc = reviewDoc({ wrong_tests: [{ path: 'tests/a.test.ts', agreed: true, reason: 'formato antigo' }] })
  expect(validateSupported('review-result', doc).valid).toBe(true)
  const bad = reviewDoc({ wrong_tests: [{ path: 'tests/a.test.ts' }] })
  expect(validateSupported('review-result', bad).valid).toBe(false)
})

// 24/09, missão real (S2): o revisor mandou uma decisão para "human" (taste-skill fora da prova de sincronização). A
// TL-ADE é autônoma: sem operador, o achado grave vai ao modelo com a instrução de escolher a opção conservadora dentro
// do escopo e registrar a escolha, em vez de sumir e deixar a rodada nova sem nada para corrigir.
test('achado_grave_para_humano_vai_ao_modelo_com_opcao_conservadora', () => {
  const request = buildReviewHandoff({ contract: CONTRACT, priorFindings: [], makerResponse: '', diff: DIFF })
  const human = finding({ id: 'F3', severity: 'high', category: 'intent_gap', target_role: 'human', required_action: 'Decidir como compatibilizar a fonte.' })
  const kept = blockingReviewFindings({ findings: [human], request, round: 1 })
  expect(kept.map((f) => f.id)).toEqual(['F3'])
  expect(kept[0].target_role).toBe('maker')
  expect(kept[0].required_action).toContain('opção conservadora')
  // achado leve para humano continua fora
  expect(blockingReviewFindings({ findings: [finding({ id: 'F4', severity: 'low', target_role: 'human' })], request, round: 1 })).toEqual([])
})
