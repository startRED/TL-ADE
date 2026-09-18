// @ts-check

/**
 * Pontos normativos de falha do motor.
 *
 * @type {readonly string[]}
 */
export const ENGINE_FAULT_POINTS = Object.freeze([
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
 * @param {string} point Ponto de falha a verificar.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] Variáveis de ambiente.
 * @returns {void}
 */
export function maybeEngineFault(point, env = process.env) {
  if (!ENGINE_FAULT_POINTS.includes(point)) {
    throw new TypeError('ponto de falha inválido: ' + point)
  }
  if (env && env.ADE_FAULT === point) {
    process.abort()
  }
}
