import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { isReviewApproved, validateEvidenceResult } from '../src/review/validate.ts'

function loadFixture(schemaName: string, kind: 'valid' | 'invalid'): Record<string, any> {
  const raw = readFileSync(
    new URL(`../fixtures/schemas/${schemaName}/${kind}.json`, import.meta.url),
    'utf8',
  )
  return JSON.parse(raw)
}

const LEGACY_V1_REVIEW_RESULT = {
  format_version: 1,
  verdict: 'approved',
  action_items: [
    {
      severity: 'minor',
      category: 'style',
      target_role: 'maker',
      location: 'src/journal/canonical.ts:10',
      problem: 'nome poderia ser mais claro',
      evidence: 'trecho do diff',
      required_action: 'renomear variável',
    },
  ],
  deferred: [],
  rejected: [],
  sources: ['0123456789abcdef'],
  summary: 'aprovado com uma observação menor',
}

const LEGACY_V1_UNIT_RESULT = {
  format_version: 1,
  story_id: 'ADE-S1',
  state: 'done',
  phase: 'green',
  round: 1,
  tree_before: '0123456789abcdef',
  tree_after: 'fedcba9876543210',
  eval_records: [
    {
      id: 'E1',
      phase: 'red',
      passed: false,
      red_reason: 'assertion_failed',
    },
  ],
  gate_records: [],
  passes: true,
  reason: 'eval verde após implementação',
  sources: ['0123456789abcdef'],
}

describe('Review and Evidence Validation', () => {
  const baseContext = {
    contractRevision: 'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
    inputRevision: {
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    },
    criteria: ['CA1'],
    verifiedRefs: [
      'eval:E1',
      'file:src/review/validate.js#L1-L30',
    ],
  }

  test('CA1: Dado um review-result 2 aprovado cujas revisões, critérios, fontes e referências coincidem com o contexto verificado, quando isReviewApproved é chamado, então retorna approved:true e errors:[]', () => {
    const reviewV2 = loadFixture('review-result', 'valid')
    const result = isReviewApproved(reviewV2, baseContext)
    expect(result.approved).toBe(true)
    expect(result.errors).toEqual([])

    const validation = validateEvidenceResult('review-result', reviewV2, baseContext)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])

    // unit-result nunca aprova
    const unitV2 = loadFixture('unit-result', 'valid')
    const unitApproved = isReviewApproved(unitV2, {
      ...baseContext,
      verifiedRefs: [
        'eval:E1',
        'file:docs/specs/evidence-review-contracts.md#L1-L200',
      ],
    })
    expect(unitApproved.approved).toBe(false)
  })

  test('CA2: Dado evidence.result_ref inexistente, claim apontando para evidence ausente, finding apontando para referência não verificada ou caminho com "..", quando validateEvidenceResult é chamado, então retorna valid:false, code:4 e o código específico no caminho ofensivo', () => {
    // 1. evidence.result_ref inexistente (não verificado pelo chamador)
    const docUnverifiedEvidence = loadFixture('review-result', 'valid')
    docUnverifiedEvidence.evidence[0].result_ref = 'artifact:inexistente'
    docUnverifiedEvidence.action_items[0].evidence_refs[0] = 'artifact:inexistente'
    docUnverifiedEvidence.handoff.claims[0].evidence_refs[0] = 'artifact:inexistente'
    const resUnverifiedEvidence = validateEvidenceResult('review-result', docUnverifiedEvidence, baseContext)
    expect(resUnverifiedEvidence.valid).toBe(false)
    if (!resUnverifiedEvidence.valid) {
      expect(resUnverifiedEvidence.code).toBe(4)
      const err = resUnverifiedEvidence.errors.find((e) => e.path === '/evidence/0/result_ref')
      expect(err).toBeDefined()
      expect(err?.code).toBe('unverified_reference')
      expect(err?.message).toBe('Referência tipada não verificada pelo ambiente de execução.')
    }

    // 2. claim apontando para evidence ausente
    const docClaimWithoutEvidence = loadFixture('review-result', 'valid')
    docClaimWithoutEvidence.handoff.claims[0].evidence_refs.push('gate:G999')
    const contextWithG999 = {
      ...baseContext,
      verifiedRefs: [...baseContext.verifiedRefs, 'gate:G999'],
    }
    const resClaimNoEvidence = validateEvidenceResult('review-result', docClaimWithoutEvidence, contextWithG999)
    expect(resClaimNoEvidence.valid).toBe(false)
    if (!resClaimNoEvidence.valid) {
      expect(resClaimNoEvidence.code).toBe(4)
      const err = resClaimNoEvidence.errors.find((e) => e.path === '/handoff/claims/0/evidence_refs/2')
      expect(err).toBeDefined()
      expect(err?.code).toBe('claim_without_evidence')
      expect(err?.message).toBe('Declaração ou apontamento sem evidência correspondente no resultado.')
    }

    // 3. finding apontando para referência não verificada
    const docFindingUnverified = loadFixture('review-result', 'valid')
    docFindingUnverified.evidence.push({
      criterion: 'CA1',
      result_ref: 'eval:E2',
      input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    })
    docFindingUnverified.action_items[0].evidence_refs.push('eval:E2')
    // eval:E2 existe em evidence, mas NÃO está em verifiedRefs
    const resFindingUnverified = validateEvidenceResult('review-result', docFindingUnverified, baseContext)
    expect(resFindingUnverified.valid).toBe(false)
    if (!resFindingUnverified.valid) {
      expect(resFindingUnverified.code).toBe(4)
      const err = resFindingUnverified.errors.find((e) => e.path === '/action_items/0/evidence_refs/2')
      expect(err).toBeDefined()
      expect(err?.code).toBe('unverified_reference')
    }

    // 4. caminho com '..'
    const docPathTraversal = loadFixture('review-result', 'valid')
    docPathTraversal.evidence[0].result_ref = 'artifact:../secret.txt'
    docPathTraversal.action_items[0].evidence_refs[0] = 'artifact:../secret.txt'
    docPathTraversal.handoff.claims[0].evidence_refs[0] = 'artifact:../secret.txt'
    const resPathTraversal = validateEvidenceResult('review-result', docPathTraversal, {
      ...baseContext,
      verifiedRefs: [...baseContext.verifiedRefs, 'artifact:../secret.txt'],
    })
    expect(resPathTraversal.valid).toBe(false)
    if (!resPathTraversal.valid) {
      expect(resPathTraversal.code).toBe(4)
      const err = resPathTraversal.errors.find((e) => e.path === '/evidence/0/result_ref')
      expect(err).toBeDefined()
      expect(err?.code).toBe('unverified_reference')
    }
  })

  test('CA3: Dado um resultado antes aprovado, quando contract_revision, input_revision.tree ou input_revision.digest corrente muda, então isReviewApproved retorna approved:false; dado format_version 1 legível, retorna legacy_result_not_approvable', () => {
    const reviewV2 = loadFixture('review-result', 'valid')

    // 1. contract_revision corrente muda
    const staleContractContext = {
      ...baseContext,
      contractRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    }
    const resStaleContract = isReviewApproved(reviewV2, staleContractContext)
    expect(resStaleContract.approved).toBe(false)
    const contractErr = resStaleContract.errors.find((e) => e.path === '/contract_revision')
    expect(contractErr).toBeDefined()
    expect(contractErr?.code).toBe('stale_contract_revision')
    expect(contractErr?.message).toBe('Revisão de contrato desatualizada ou divergente do contrato corrente.')

    // 2. input_revision.tree corrente muda (40 caracteres de '1' para '2')
    const staleTreeContext = {
      ...baseContext,
      inputRevision: {
        ...baseContext.inputRevision,
        tree: '2'.repeat(40),
      },
    }
    const resStaleTree = isReviewApproved(reviewV2, staleTreeContext)
    expect(resStaleTree.approved).toBe(false)
    const treeErr = resStaleTree.errors.find((e) => e.path === '/input_revision/tree')
    expect(treeErr).toBeDefined()
    expect(treeErr?.code).toBe('stale_input_revision')
    expect(treeErr?.message).toBe('Revisão de insumos desatualizada em relação à árvore ou insumos correntes.')

    // 3. input_revision.digest corrente muda
    const staleDigestContext = {
      ...baseContext,
      inputRevision: {
        ...baseContext.inputRevision,
        digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      },
    }
    const resStaleDigest = isReviewApproved(reviewV2, staleDigestContext)
    expect(resStaleDigest.approved).toBe(false)
    const digestErr = resStaleDigest.errors.find((e) => e.path === '/input_revision/digest')
    expect(digestErr).toBeDefined()
    expect(digestErr?.code).toBe('stale_input_revision')

    // 4. formato legado v1 é legível mas retorna legacy_result_not_approvable
    const legacyReview = LEGACY_V1_REVIEW_RESULT
    const resLegacyApproved = isReviewApproved(legacyReview, baseContext)
    expect(resLegacyApproved.approved).toBe(false)
    const legacyErr = resLegacyApproved.errors.find((e) => e.path === '/format_version')
    expect(legacyErr).toBeDefined()
    expect(legacyErr?.code).toBe('legacy_result_not_approvable')
    expect(legacyErr?.message).toBe('Resultados em formato legado (v1) são somente leitura e não podem aprovar o fluxo novo.')

    const resLegacyValidation = validateEvidenceResult('review-result', legacyReview, baseContext)
    expect(resLegacyValidation.valid).toBe(false)
    if (!resLegacyValidation.valid) {
      expect(resLegacyValidation.code).toBe(4)
      expect(resLegacyValidation.errors.some((e) => e.code === 'legacy_result_not_approvable')).toBe(true)
    }

    const legacyUnit = LEGACY_V1_UNIT_RESULT
    const resLegacyUnitApproved = isReviewApproved(legacyUnit, baseContext)
    expect(resLegacyUnitApproved.approved).toBe(false)
    expect(resLegacyUnitApproved.errors.some((e) => e.code === 'legacy_result_not_approvable')).toBe(true)

    // 5. Contexto ausente ou incompleto impede aprovação e trata referências como não verificadas
    const resNoContext = isReviewApproved(reviewV2)
    expect(resNoContext.approved).toBe(false)
    expect(resNoContext.errors.length).toBeGreaterThan(0)

    const incompleteContext = {
      contractRevision: baseContext.contractRevision,
      inputRevision: baseContext.inputRevision,
      criteria: baseContext.criteria,
    }
    const resIncomplete = isReviewApproved(reviewV2, incompleteContext)
    expect(resIncomplete.approved).toBe(false)
    expect(resIncomplete.errors.some((e) => e.code === 'unverified_reference')).toBe(true)

    const valNoContext = validateEvidenceResult('review-result', reviewV2)
    expect(valNoContext.valid).toBe(false)
    if (!valNoContext.valid) {
      expect(valNoContext.code).toBe(4)
    }
  })

  test('CA4: Dado notes contendo 126 caracteres "😀", quando validateEvidenceResult é chamado, então retorna notes_too_large porque o conteúdo possui 504 bytes UTF-8', () => {
    const reviewV2 = loadFixture('review-result', 'valid')
    reviewV2.handoff.notes = '😀'.repeat(126)

    const result = validateEvidenceResult('review-result', reviewV2, baseContext)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe(4)
      const err = result.errors.find((e) => e.path === '/handoff/notes')
      expect(err).toBeDefined()
      expect(err?.code).toBe('notes_too_large')
      expect(err?.message).toBe('Campo notes excede o limite máximo contratual de 500 bytes.')
    }

    // Notes ASCII com 501 caracteres retorna notes_too_large em vez de erro de schema Ajv
    const docAscii501 = loadFixture('review-result', 'valid')
    docAscii501.handoff.notes = 'a'.repeat(501)
    const resAscii501 = validateEvidenceResult('review-result', docAscii501, baseContext)
    expect(resAscii501.valid).toBe(false)
    if (!resAscii501.valid) {
      expect(resAscii501.code).toBe(4)
      const errAscii = resAscii501.errors.find((e) => e.path === '/handoff/notes')
      expect(errAscii).toBeDefined()
      expect(errAscii?.code).toBe('notes_too_large')
      expect(errAscii?.message).toBe('Campo notes excede o limite máximo contratual de 500 bytes.')
    }

    // Também valida next_action_mismatch
    const docActionMismatch = loadFixture('review-result', 'valid')
    docActionMismatch.handoff.next_action = 'rework'
    docActionMismatch.requested_action = 'verify'
    const resActionMismatch = validateEvidenceResult('review-result', docActionMismatch, baseContext)
    expect(resActionMismatch.valid).toBe(false)
    if (!resActionMismatch.valid) {
      expect(resActionMismatch.code).toBe(4)
      const err = resActionMismatch.errors.find((e) => e.path === '/handoff/next_action')
      expect(err).toBeDefined()
      expect(err?.code).toBe('next_action_mismatch')
      expect(err?.message).toBe('Incompatibilidade entre next_action do handoff e requested_action do resultado.')
    }
  })
})
