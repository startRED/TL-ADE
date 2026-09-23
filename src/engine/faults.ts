// @ts-check

/**
 * Pontos normativos de falha do motor.
 */
export const ENGINE_FAULT_POINTS: readonly string[] = Object.freeze([
  'before_spawn',
  'after_maker_effect',
  'before_contain',
  'after_contain',
  'before_commit',
  'after_commit',
])

/**
 * Dispara ponto de falha do motor se configurado no ambiente via ADE_FAULT.
 *
 * @param point Ponto de falha a verificar.
 * @param [env] Variáveis de ambiente.
 */
export function maybeEngineFault(point: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): void {
  if (!ENGINE_FAULT_POINTS.includes(point)) {
    throw new TypeError('ponto de falha inválido: ' + point)
  }
  if (env && env.ADE_FAULT === point) {
    process.abort()
  }
}
