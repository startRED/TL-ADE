import { AdeError } from '../journal/errors.js'

/**
 * Obtém a data/hora de início do processo para fingerprinting anti-reúso de PID (s5).
 * @param {number} _pid
 * @param {unknown} [_deps]
 */
export function getProcessStartTime(_pid, _deps) {
  throw new AdeError('not_implemented', 'não implementado: s5', 2)
}

/**
 * Verifica se um processo ainda está vivo no sistema operacional (s5).
 * @param {number} _pid
 * @param {unknown} [_killImpl]
 */
export function isProcessAlive(_pid, _killImpl) {
  throw new AdeError('not_implemented', 'não implementado: s5', 2)
}
