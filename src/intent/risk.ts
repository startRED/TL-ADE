/**
 * Avalia o risco objetivo do pedido com base na solicitação e evidências descobertas.
 */
export function assessRisk({ request = '', discovery = {} }: { request?: string; discovery?: any; classification?: any }): { level: 'light' | 'normal' | 'critical'; surfaces: string[]; evidence: string[]; sensitive_paths?: string[]; ask_operator?: string[] } {
  const anchors = discovery.anchors || []
  const isAuth =
    /autentica[çc][ãa]o|senha|admin|auth|token|permiss[ãa]o|credential/i.test(request) ||
    anchors.some((a: any) => (a.term && a.term.includes('auth')) || (a.path && a.path.includes('auth')))

  if (isAuth) {
    const evidence = []
    for (const a of anchors) {
      if ((a.term && a.term.includes('auth')) || (a.path && a.path.includes('auth'))) {
        evidence.push(`anchor:${a.path}:${a.line || 1}`)
      }
    }
    if (evidence.length === 0) {
      evidence.push('keyword:auth')
    }

    return {
      level: 'critical',
      surfaces: ['auth'],
      evidence,
      sensitive_paths: ['src/auth/**'],
      ask_operator: ['Confirmar alteração de fluxo crítico de autenticação/segurança'],
    }
  }

  return {
    level: 'normal',
    surfaces: [],
    evidence: [],
  }
}

// segurança, login e autenticação, pagamento e migração de banco (ADR 0033)
const SENSITIVE = /seguran[çc]a|security|login|senha|password|autentica|auth|pagamento|payment|billing|migra[çc][ãa]o de banco|db_migration|database_migration/i

/** Risco da parte para a escada: sensível pelo título ou pelas superfícies do contrato; leve só quando o contrato diz. */
export function storyRisk(contract: { title?: unknown; risk?: Record<string, unknown> }): 'light' | 'normal' | 'sensitive' {
  const surfaces = Array.isArray(contract.risk?.surfaces) ? contract.risk.surfaces : []
  if (contract.risk?.level === 'critical' || SENSITIVE.test([contract.title ?? '', ...surfaces].join(' '))) return 'sensitive'
  return contract.risk?.level === 'light' ? 'light' : 'normal'
}
