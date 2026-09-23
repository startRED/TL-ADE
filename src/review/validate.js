import { validateSupported } from '../schema/index.ts'

export const RESULT_FORMAT_VERSION = 2

export const REQUESTED_ACTIONS = Object.freeze([
  'verify',
  'rework',
  'decide',
])

export const REFERENCE_PREFIXES = Object.freeze([
  'eval:',
  'gate:',
  'artifact:',
  'source:',
  'file:',
  'trace:',
])

/**
 * Verifica se uma referência possui caminho inseguro (travessia com '..', caminho absoluto ou com raiz).
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
function isPathInsecure(ref) {
  if (typeof ref !== 'string') return true
  if (ref.includes('..')) return true
  if (ref.startsWith('artifact:')) {
    const p = ref.slice('artifact:'.length)
    if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
      return true
    }
  }
  if (ref.startsWith('file:')) {
    const filePart = ref.slice('file:'.length).split('#')[0]
    if (filePart.startsWith('/') || filePart.startsWith('\\') || /^[a-zA-Z]:/.test(filePart)) {
      return true
    }
  }
  return false
}

/**
 * Verifica se o caminho do erro do schema refere-se a um campo de referência tipada.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isRefPath(path) {
  return (
    path.endsWith('/result_ref') ||
    path.includes('/evidence_refs/') ||
    path.includes('/sources/') ||
    path.endsWith('/ref') ||
    path.endsWith('/sources')
  )
}

/**
 * Valida semanticamente um resultado de unidade ou de revisão contra o contexto corrente.
 *
 * @param {'unit-result' | 'review-result'} schemaName
 * @param {any} doc
 * @param {{
 *   contractRevision?: string,
 *   contract_revision?: string,
 *   inputRevision?: string | { tree: string, digest: string },
 *   input_revision?: string | { tree: string, digest: string },
 *   criteria?: string[],
 *   verifiedRefs?: string[],
 *   verified_refs?: string[]
 * }} [context]
 * @returns {{ valid: true, errors: [] } | { valid: false, errors: Array<{ path: string, code: string, message: string }>, code: 4 }}
 */
export function validateEvidenceResult(schemaName, doc, context = {}) {
  if (!doc || typeof doc !== 'object') {
    return {
      valid: false,
      errors: [
        {
          path: '/',
          code: 'unsupported_result_format',
          message: 'Formato de resultado não suportado; esperado format_version 2.',
        },
      ],
      code: 4,
    }
  }

  const inputRevision = context?.inputRevision ?? context?.input_revision
  const structuredInputRevision =
    inputRevision && typeof inputRevision === 'object' ? inputRevision : null
  if (
    doc.input_revision &&
    inputRevision
  ) {
    const docRevStr = typeof doc.input_revision === 'string' ? doc.input_revision : null
    const ctxRevStr = typeof inputRevision === 'string' ? inputRevision : null
    if (docRevStr && ctxRevStr && docRevStr !== ctxRevStr) {
      return {
        valid: false,
        errors: [
          {
            path: '/input_revision',
            code: 'stale_result',
            message: 'Resultado obsoleto: input_revision divergente do contexto.',
          },
        ],
        code: 4,
      }
    }
  }


  if (doc.format_version === 1) {
    return {
      valid: false,
      errors: [
        {
          path: '/format_version',
          code: 'legacy_result_not_approvable',
          message: 'Resultados em formato legado (v1) são somente leitura e não podem aprovar o fluxo novo.',
        },
      ],
      code: 4,
    }
  }

  if (doc.format_version !== RESULT_FORMAT_VERSION) {
    return {
      valid: false,
      errors: [
        {
          path: '/format_version',
          code: 'unsupported_result_format',
          message: 'Formato de resultado não suportado; esperado format_version 2.',
        },
      ],
      code: 4,
    }
  }

  const notesTooLarge =
    typeof doc?.handoff?.notes === 'string' &&
    Buffer.byteLength(doc.handoff.notes, 'utf8') > 500

  // Validação estrutural do schema
  const schemaValidation = validateSupported(schemaName, doc)
  if (!schemaValidation.valid) {
    /** @type {Array<{ path: string, code: string, message: string }>} */
    const errors = schemaValidation.errors.map((err) => {
      if (err.path === '/handoff/notes' && notesTooLarge) {
        return {
          path: '/handoff/notes',
          code: 'notes_too_large',
          message: 'Campo notes excede o limite máximo contratual de 500 bytes.',
        }
      }
      if ((err.code === 'pattern' || err.code === 'schema_error') && isRefPath(err.path)) {
        return {
          path: err.path,
          code: 'unverified_reference',
          message: 'Referência tipada não verificada pelo ambiente de execução.',
        }
      }
      return {
        path: err.path,
        code: err.code ?? 'schema_error',
        message: err.message,
      }
    })
    if (notesTooLarge && !errors.some((e) => e.path === '/handoff/notes')) {
      errors.push({
        path: '/handoff/notes',
        code: 'notes_too_large',
        message: 'Campo notes excede o limite máximo contratual de 500 bytes.',
      })
    }
    return {
      valid: false,
      errors,
      code: 4,
    }
  }

  /** @type {Array<{ path: string, code: string, message: string }>} */
  const errors = []

  const contractRevision = context?.contractRevision ?? context?.contract_revision
  const criteria = context?.criteria ?? []
  const verifiedRefsList = Array.isArray(context?.verifiedRefs)
    ? context.verifiedRefs
    : (Array.isArray(context?.verified_refs) ? context.verified_refs : null)
  const verifiedRefs = new Set(verifiedRefsList ?? [])

  /**
   * @param {string} ref
   * @returns {boolean}
   */
  function isRefVerified(ref) {
    if (isPathInsecure(ref)) return false
    if (!verifiedRefsList) return false
    if (verifiedRefs.has(ref)) return true
    if (typeof ref === 'string' && ref.startsWith('file:')) {
      const [baseFile] = ref.split('#')
      if (verifiedRefs.has(baseFile)) return true
    }
    return false
  }

  // 1. Comparar contract_revision
  if (!contractRevision || doc.contract_revision !== contractRevision) {
    errors.push({
      path: '/contract_revision',
      code: 'stale_contract_revision',
      message: 'Revisão de contrato desatualizada ou divergente do contrato corrente.',
    })
  }

  // 2. Comparar input_revision (tree e digest)
  if (!structuredInputRevision?.tree || doc.input_revision?.tree !== structuredInputRevision.tree) {
    errors.push({
      path: '/input_revision/tree',
      code: 'stale_input_revision',
      message: 'Revisão de insumos desatualizada em relação à árvore ou insumos correntes.',
    })
  }
  if (!structuredInputRevision?.digest || doc.input_revision?.digest !== structuredInputRevision.digest) {
    errors.push({
      path: '/input_revision/digest',
      code: 'stale_input_revision',
      message: 'Revisão de insumos desatualizada em relação à árvore ou insumos correntes.',
    })
  }

  // 3. Comparar handoff.next_action com requested_action
  if (doc.handoff && doc.requested_action !== undefined) {
    if (doc.handoff.next_action !== doc.requested_action) {
      errors.push({
        path: '/handoff/next_action',
        code: 'next_action_mismatch',
        message: 'Incompatibilidade entre next_action do handoff e requested_action do resultado.',
      })
    }
  }

  // 4. Medir handoff.notes por Buffer.byteLength (máx 500 bytes UTF-8)
  if (notesTooLarge) {
    errors.push({
      path: '/handoff/notes',
      code: 'notes_too_large',
      message: 'Campo notes excede o limite máximo contratual de 500 bytes.',
    })
  }

  // 5. Validar evidence (presença em verifiedRefs e segurança de caminhos)
  const evidenceResultRefs = new Set()
  if (Array.isArray(doc.evidence)) {
    for (let index = 0; index < doc.evidence.length; index++) {
      const item = doc.evidence[index]
      if (item && typeof item === 'object') {
        const ref = item.result_ref
        evidenceResultRefs.add(ref)

        if (!isRefVerified(ref)) {
          errors.push({
            path: `/evidence/${index}/result_ref`,
            code: 'unverified_reference',
            message: 'Referência tipada não verificada pelo ambiente de execução.',
          })
        }
      }
    }
  }

  // 6. Validar sources
  if (Array.isArray(doc.sources)) {
    for (let index = 0; index < doc.sources.length; index++) {
      const src = doc.sources[index]
      if (!isRefVerified(src)) {
        errors.push({
          path: `/sources/${index}`,
          code: 'unverified_reference',
          message: 'Referência tipada não verificada pelo ambiente de execução.',
        })
      }
    }
  }

  // 7. Validar handoff.claims
  if (Array.isArray(doc.handoff?.claims)) {
    for (let claimIdx = 0; claimIdx < doc.handoff.claims.length; claimIdx++) {
      const claim = doc.handoff.claims[claimIdx]
      if (Array.isArray(claim?.evidence_refs)) {
        for (let refIdx = 0; refIdx < claim.evidence_refs.length; refIdx++) {
          const ref = claim.evidence_refs[refIdx]
          if (!evidenceResultRefs.has(ref)) {
            errors.push({
              path: `/handoff/claims/${claimIdx}/evidence_refs/${refIdx}`,
              code: 'claim_without_evidence',
              message: 'Declaração ou apontamento sem evidência correspondente no resultado.',
            })
          }
          if (!isRefVerified(ref)) {
            errors.push({
              path: `/handoff/claims/${claimIdx}/evidence_refs/${refIdx}`,
              code: 'unverified_reference',
              message: 'Referência tipada não verificada pelo ambiente de execução.',
            })
          }
        }
      }

      if (Array.isArray(claim?.sources)) {
        for (let srcIdx = 0; srcIdx < claim.sources.length; srcIdx++) {
          const src = claim.sources[srcIdx]
          if (!isRefVerified(src)) {
            errors.push({
              path: `/handoff/claims/${claimIdx}/sources/${srcIdx}`,
              code: 'unverified_reference',
              message: 'Referência tipada não verificada pelo ambiente de execução.',
            })
          }
        }
      }
    }
  }

  // 8. Validar findings (action_items, deferred, rejected, findings)
  const findingSections = ['action_items', 'deferred', 'rejected', 'findings']
  for (let s = 0; s < findingSections.length; s++) {
    const section = findingSections[s]
    const items = doc[section]
    if (Array.isArray(items)) {
      for (let findingIdx = 0; findingIdx < items.length; findingIdx++) {
        const finding = items[findingIdx]
        if (Array.isArray(finding?.evidence_refs)) {
          for (let refIdx = 0; refIdx < finding.evidence_refs.length; refIdx++) {
            const ref = finding.evidence_refs[refIdx]
            if (!evidenceResultRefs.has(ref)) {
              errors.push({
                path: `/${section}/${findingIdx}/evidence_refs/${refIdx}`,
                code: 'claim_without_evidence',
                message: 'Declaração ou apontamento sem evidência correspondente no resultado.',
              })
            }
            if (!isRefVerified(ref)) {
              errors.push({
                path: `/${section}/${findingIdx}/evidence_refs/${refIdx}`,
                code: 'unverified_reference',
                message: 'Referência tipada não verificada pelo ambiente de execução.',
              })
            }
          }
        }
      }
    }
  }

  // 9. Validar handoff.deltas
  if (Array.isArray(doc.handoff?.deltas)) {
    for (let deltaIdx = 0; deltaIdx < doc.handoff.deltas.length; deltaIdx++) {
      const delta = doc.handoff.deltas[deltaIdx]
      if (delta?.ref && !isRefVerified(delta.ref)) {
        errors.push({
          path: `/handoff/deltas/${deltaIdx}/ref`,
          code: 'unverified_reference',
          message: 'Referência tipada não verificada pelo ambiente de execução.',
        })
      }
    }
  }

  // 10. Validar critérios contra doc.evidence
  if (Array.isArray(criteria) && criteria.length > 0) {
    const docCriteria = new Set()
    if (Array.isArray(doc.evidence)) {
      for (let i = 0; i < doc.evidence.length; i++) {
        if (doc.evidence[i]?.criterion) {
          docCriteria.add(doc.evidence[i].criterion)
        }
      }
    }
    for (let c = 0; c < criteria.length; c++) {
      const crit = criteria[c]
      if (!docCriteria.has(crit)) {
        errors.push({
          path: '/evidence',
          code: 'claim_without_evidence',
          message: 'Declaração ou apontamento sem evidência correspondente no resultado.',
        })
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      code: 4,
    }
  }

  return {
    valid: true,
    errors: [],
  }
}

/**
 * Avalia se o resultado de revisão é aprovado formalmente.
 * Retorna true somente para review-result format_version 2 válido com verdict 'approved'.
 * Unit-result e resultados legados nunca aprovam.
 *
 * @param {any} doc
 * @param {any} [context]
 * @returns {{ approved: boolean, errors: Array<{ path: string, code: string, message: string }> }}
 */
export function isReviewApproved(doc, context = {}) {
  if (!doc || typeof doc !== 'object') {
    return {
      approved: false,
      errors: [
        {
          path: '/',
          code: 'unsupported_result_format',
          message: 'Formato de resultado não suportado; esperado format_version 2.',
        },
      ],
    }
  }

  if (doc.format_version === 1) {
    return {
      approved: false,
      errors: [
        {
          path: '/format_version',
          code: 'legacy_result_not_approvable',
          message: 'Resultados em formato legado (v1) são somente leitura e não podem aprovar o fluxo novo.',
        },
      ],
    }
  }

  // Unit-result nunca aprova (ready_for_verification não aprova)
  if ('state' in doc && !('verdict' in doc)) {
    return {
      approved: false,
      errors: [
        {
          path: '/verdict',
          code: 'unsupported_result_format',
          message: 'Unit-result não possui veredito de aprovação; ready_for_verification não aprova.',
        },
      ],
    }
  }

  const validation = validateEvidenceResult('review-result', doc, context)
  if (!validation.valid) {
    return {
      approved: false,
      errors: validation.errors,
    }
  }

  if (doc.verdict !== 'approved') {
    return {
      approved: false,
      errors: [],
    }
  }

  return {
    approved: true,
    errors: [],
  }
}
