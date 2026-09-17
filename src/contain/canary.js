import { AdeError } from '../journal/errors.js'

/**
 * @typedef {Object} CanaryInput
 * @property {string} targetDir
 * @property {string} [family]
 * @property {string} [prefix]
 */

/**
 * @typedef {Object} CanaryState
 * @property {string} id
 * @property {string} path
 * @property {string} token
 * @property {number} plantedAt
 */

/**
 * @typedef {Object} CanaryCheckResult
 * @property {boolean} intact
 * @property {string} [reason]
 */

/**
 * Planta um canário de isolamento fora do worktree.
 *
 * @param {CanaryInput} _input
 * @returns {Promise<CanaryState>}
 */
export async function plantCanary(_input) {
  throw new AdeError('not_implemented', 'canário chega na story s7', 2)
}

/**
 * Verifica se o canário foi violado por escritas indevidas.
 *
 * @param {CanaryState} _canary
 * @returns {Promise<CanaryCheckResult>}
 */
export async function checkCanary(_canary) {
  throw new AdeError('not_implemented', 'canário chega na story s7', 2)
}

/**
 * Assegura que o canário permanece intacto; lança se violado.
 *
 * @param {CanaryState} _canary
 * @returns {Promise<void>}
 */
export async function assertCanaryIntact(_canary) {
  throw new AdeError('not_implemented', 'canário chega na story s7', 2)
}
