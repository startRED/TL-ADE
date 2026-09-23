import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'

/**
 * Sinaliza inferência sem proveniência completa (confiança ou evidências).
 */
export class IrInferenceInvalidError extends AdeError {
  /**
   * @param {number} index
   * @param {string} reason
   */
  constructor(index, reason) {
    super('ir_inference_invalid', `inferência ${index} inválida: ${reason}`, 4, { index, reason })
  }
}

/**
 * @param {any} item
 * @param {number} index
 * @returns {{ confidence: number, evidence_refs: string[], provenance: 'inference' }}
 */
function assertInference(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new IrInferenceInvalidError(index, 'não é um objeto')
  }
  const { confidence, evidence_refs } = item
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new IrInferenceInvalidError(index, 'confidence ausente ou fora de [0,1]')
  }
  if (
    !Array.isArray(evidence_refs) ||
    evidence_refs.length === 0 ||
    evidence_refs.some((/** @type {any} */ r) => typeof r !== 'string' || r.length === 0)
  ) {
    throw new IrInferenceInvalidError(index, 'evidence_refs ausente ou inválida')
  }
  return { ...item, provenance: 'inference' }
}

/**
 * Constrói o IR (Intermediate Representation) do repositório segregando proveniência.
 *
 * @param {{
 *   workspace?: import('../workspace/port.ts').WorkspacePort,
 *   discovery: any,
 *   producer?: (ambiguities: any[]) => Promise<any[]>,
 *   operatorDecisions?: Array<{ id: string, decision: string, source: string }>,
 * }} options
 * @returns {Promise<{
 *   kind: string,
 *   ref: string,
 *   revision: string,
 *   digest: string,
 *   provenance: string[],
 *   data: {
 *     facts: any[],
 *     inferences: any[],
 *     operator_decisions: any[],
 *     symbols: any[],
 *     relations: any[],
 *     tree_state: any,
 *   }
 * }>}
 */
export async function buildRepoIr({
  workspace: _workspace,
  discovery,
  producer,
  operatorDecisions = [],
}) {
  /** @type {any[]} */
  const rawFacts = discovery.facts || []
  const facts = rawFacts.map((/** @type {any} */ f) => ({
    ...f,
    provenance: 'fact',
  }))

  /** @type {any[]} */
  let inferences = []
  if (typeof producer === 'function') {
    const raw = await producer(discovery.ambiguities || [])
    if (raw !== null && raw !== undefined) {
      if (!Array.isArray(raw)) {
        throw new IrInferenceInvalidError(-1, 'produtor não devolveu uma lista de inferências')
      }
      inferences = raw.map(assertInference)
    }
  }

  const decisions = operatorDecisions.map((d) => ({
    ...d,
    provenance: 'operator_decision',
  }))

  const provenance = ['fact']
  if (inferences.length > 0) {
    provenance.push('inference')
  }
  if (decisions.length > 0) {
    provenance.push('operator_decision')
  }

  /** @type {any[]} */
  const rawSymbols = discovery.symbols || []
  const symbols = rawSymbols.map((/** @type {any} */ s) => ({
    ...s,
    ref: s.ref || `repo:symbol:${s.name}`,
  }))

  const revision = discovery.tree_state?.revision || 'unknown'

  const data = {
    facts,
    inferences,
    operator_decisions: decisions,
    symbols,
    relations: discovery.relations || [],
    tree_state: discovery.tree_state || null,
  }

  // O digest cobre todo o conteúdo certificado devolvido em data: dois IRs com
  // relações ou estado de árvore diferentes nunca compartilham ref.
  const digest = digest16({ revision, ...data })

  return {
    kind: 'repo-ir',
    ref: `art:repo-ir/${digest}`,
    revision,
    digest,
    provenance,
    data,
  }
}
