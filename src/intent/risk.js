/**
 * Avalia o risco objetivo do pedido com base na solicitação e evidências descobertas.
 *
 * @param {{ request?: string, discovery?: any, classification?: any }} input
 * @returns {{ level: 'light' | 'normal' | 'critical', surfaces: string[], evidence: string[], sensitive_paths?: string[], ask_operator?: string[] }}
 */
export function assessRisk({ request = '', discovery = {} }) {
  const anchors = discovery.anchors || []
  const isAuth =
    /autentica[çc][ãa]o|senha|admin|auth|token|permiss[ãa]o|credential/i.test(request) ||
    anchors.some((/** @type {any} */ a) => (a.term && a.term.includes('auth')) || (a.path && a.path.includes('auth')))

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
