import { AdeError } from './errors.js'

export const GENESIS_PREV = '0000000000000000'

/**
 * Abre o diário append-only garantindo integridade e lock do escritor (s2).
 * @param {unknown} _options
 */
export function openJournal(_options) {
  throw new AdeError('not_implemented', 'não implementado: s2', 2)
}

/**
 * Lê e valida sequencialmente o diário e a cadeia de hash (s3).
 * @param {string} _filePath
 */
export function readJournal(_filePath) {
  throw new AdeError('not_implemented', 'não implementado: s3', 2)
}

/**
 * Reduz a sequência de eventos de um journal no estado consolidado da missão (s4).
 * @param {Array<unknown>} _events
 */
export function fold(_events) {
  throw new AdeError('not_implemented', 'não implementado: s4', 2)
}
