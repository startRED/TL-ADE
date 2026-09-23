// Pontos de injeção de falha para provar a durabilidade do write-ahead do step().

/** Os três pontos de falha válidos, na ordem em que ocorrem dentro de step(). */
export const FAULT_POINTS = ['after_intent', 'after_effect', 'after_result']

/**
 * Aborta o processo imediatamente se `env.ADE_FAULT` casar com o ponto informado.
 * Usado pelas provas de queda para simular o processo morrendo entre a gravação
 * da intenção, o efeito e o resultado.
 */
export function maybeFault(point: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!FAULT_POINTS.includes(point)) {
    throw new TypeError('ponto de falha inválido: ' + point)
  }
  if (env.ADE_FAULT === point) {
    process.abort()
  }
}
