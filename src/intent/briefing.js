/**
 * Gera o briefing determinístico registrando direção e próxima entrega.
 *
 * @param {{ request?: string, discovery?: any, classification?: any, risk?: any }} input
 * @returns {{ direction: object, next_delivery: object, classification: object, risk: object }}
 */
export function generateBriefing({ request = '', discovery = {}, classification = {}, risk = {} }) {
  return {
    direction: {
      intent: request,
      vision: `Direção estratégica para: ${request}`,
      target_scope: discovery?.repo?.head ? `head:${discovery.repo.head}` : 'main',
    },
    next_delivery: {
      scope: 'Fatia executável imediata',
      phase: 1,
      deliverable: `Entrega inicial para: ${request.slice(0, 60)}...`,
    },
    classification,
    risk,
  }
}
