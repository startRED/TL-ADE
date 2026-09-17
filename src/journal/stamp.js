import { StaleWorkflowVersionError } from './errors.js'
import { openIntents } from './fold.js'

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
} = /** @type {any} */ ({})) {
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
 * @typedef {{
 *   seq: number,
 *   step_id: string,
 *   effect_class: string,
 *   runtime_stamp: string,
 * }} StaleIntent
 */

/**
 * Localiza intenções abertas emitidas sob core_version incompatível com o atual.
 * @param {ReadonlyArray<Record<string, unknown>>} [events]
 * @param {number} [currentCoreVersion=CORE_VERSION]
 * @returns {Array<StaleIntent>}
 */
export function findStaleIntents(events = [], currentCoreVersion = CORE_VERSION) {
  /** @type {Set<number>} */
  const acceptedSeqs = new Set()

  if (Array.isArray(events)) {
    for (const ev of events) {
      if (
        ev &&
        typeof ev === 'object' &&
        ev.kind === 'decision' &&
        ev.data &&
        typeof ev.data === 'object'
      ) {
        /** @type {Record<string, unknown>} */
        const data = /** @type {Record<string, unknown>} */ (ev.data)
        if (
          data.decision === 'accept_stale_version' &&
          data.current_core_version === currentCoreVersion &&
          Array.isArray(data.stale_seqs)
        ) {
          for (const s of data.stale_seqs) {
            if (typeof s === 'number') {
              acceptedSeqs.add(s)
            }
          }
        }
      }
    }
  }

  return openIntents(events)
    .filter(
      (i) =>
        parseRuntimeStamp(i.runtime_stamp).coreVersion !== currentCoreVersion &&
        !acceptedSeqs.has(i.seq),
    )
    .map(({ seq, step_id, effect_class, runtime_stamp }) => ({
      seq,
      step_id,
      effect_class,
      runtime_stamp,
    }))
}

/**
 * Assegura que o stamp em uso é compatível com a sessão corrente.
 * @param {ReadonlyArray<Record<string, unknown>>} [events]
 * @param {number} [currentCoreVersion=CORE_VERSION]
 * @returns {void}
 * @throws {StaleWorkflowVersionError}
 */
export function assertStampCurrent(events = [], currentCoreVersion = CORE_VERSION) {
  const stale = findStaleIntents(events, currentCoreVersion)
  if (stale.length > 0) {
    throw new StaleWorkflowVersionError(stale, currentCoreVersion)
  }
}

/**
 * Grava decisão autorizando prosseguimento com versão desatualizada.
 * @param {{ append(partial: Record<string, unknown>): Promise<Record<string, unknown>> }} journal
 * @param {ReadonlyArray<Record<string, unknown>>} events
 * @param {{ source?: string, currentCoreVersion?: number }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function acceptStaleVersion(
  journal,
  events,
  { source = 'operator', currentCoreVersion = CORE_VERSION } = {},
) {
  const stale = findStaleIntents(events, currentCoreVersion)
  if (stale.length === 0) {
    return null
  }
  return journal.append({
    kind: 'decision',
    source,
    data: {
      decision: 'accept_stale_version',
      current_core_version: currentCoreVersion,
      stale_seqs: stale.map((s) => s.seq),
    },
  })
}

