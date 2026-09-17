import { fold } from './journal.js'
import { AdeError } from './errors.js'

export const CORE_VERSION = 1

const STAMP_PATTERN = /^[0-9]+:[0-9a-f]+:[0-9a-f]+$/

/**
 * Monta o runtime_stamp canônico a partir da versão do core e digests de configuração.
 * @param {{coreVersion?: number, configDigest: string, capabilitiesDigest: string}} [options]
 * @returns {string}
 */
export function buildRuntimeStamp({
  coreVersion = CORE_VERSION,
  configDigest,
  capabilitiesDigest,
} = {}) {
  const stamp = `${coreVersion}:${configDigest}:${capabilitiesDigest}`
  if (!Number.isInteger(coreVersion) || coreVersion < 0 || !STAMP_PATTERN.test(stamp)) {
    throw new TypeError('runtime_stamp inválido: ' + stamp)
  }
  return stamp
}

/**
 * Faz o parsing estruturado de um runtime_stamp validando seu padrão canônico.
 * @param {string} stamp
 * @returns {{coreVersion: number, configDigest: string, capabilitiesDigest: string}}
 */
export function parseRuntimeStamp(stamp) {
  if (typeof stamp !== 'string' || !STAMP_PATTERN.test(stamp)) {
    throw new TypeError('runtime_stamp inválido: ' + stamp)
  }
  const [coreVerStr, configDigest, capabilitiesDigest] = stamp.split(':')
  return {
    coreVersion: Number.parseInt(coreVerStr, 10),
    configDigest,
    capabilitiesDigest,
  }
}

/**
 * Localiza intenções abertas emitidas sob core_version incompatível com o atual (s4).
 * @param {unknown} [_intents]
 * @param {number} [_currentCoreVersion]
 */
export function findStaleIntents(..._args) {
  throw new AdeError('not_implemented', 'não implementado: s4', 2)
}

/**
 * Assegura que o stamp em uso é compatível com a sessão corrente (s4).
 * @param {unknown} [_stamp]
 */
export function assertStampCurrent(..._args) {
  throw new AdeError('not_implemented', 'não implementado: s4', 2)
}

/**
 * Grava decisão autorizando prosseguimento com versão desatualizada (s4).
 * @param {unknown} [_options]
 */
export function acceptStaleVersion(..._args) {
  throw new AdeError('not_implemented', 'não implementado: s4', 2)
}
