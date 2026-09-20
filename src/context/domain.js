import { digest16 } from '../journal/canonical.js'
import { resolveScopeOwners } from './scope-owners.js'

/**
 * Compila o contexto de domínio certificado para o contrato sob escopo e orçamento.
 *
 * @param {{
 *   contract: { id: string, task?: string, guardrails?: { scope_paths?: string[] }, risk?: any },
 *   ir: any,
 *   domain: string,
 *   budget?: number,
 *   scopeRules?: Array<{ pattern: string, owner: string, ref?: string }>,
 * }} options
 * @returns {{
 *   kind: 'domain-context',
 *   digest: string,
 *   ref: string,
 *   data: {
 *     domain: string,
 *     contract_id: string,
 *     task?: string,
 *     scope_owners: Array<{ pattern: string, owner: string, ref?: string }>,
 *     budget: number,
 *     symbols: any[],
 *     risk: any,
 *     ir_ref: string | null,
 *   },
 * }}
 */
export function compileDomainContext({
  contract,
  ir,
  domain,
  budget = 1000,
  scopeRules = [],
}) {
  const paths = contract.guardrails?.scope_paths || []
  const scope_owners = resolveScopeOwners({ paths, rules: scopeRules })

  const data = {
    domain,
    contract_id: contract.id,
    task: contract.task,
    scope_owners,
    budget,
    symbols: ir?.data?.symbols || [],
    risk: contract.risk || null,
  }

  // O digest cobre todo o conteúdo certificado, inclusive a identidade do IR:
  // artefatos diferentes nunca compartilham chave endereçada por conteúdo.
  const ir_ref = ir?.ref || (ir?.digest ? `art:repo-ir/${ir.digest}` : null)
  const digest = digest16({ ...data, ir_digest: ir?.digest ?? null, ir_ref })

  return {
    kind: 'domain-context',
    digest,
    ref: `art:domain-context/${digest}`,
    data: { ...data, ir_ref },
  }
}
