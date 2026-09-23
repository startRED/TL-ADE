import { StaleWorkflowVersionError } from './errors.ts'
import { openIntents } from './fold.ts'

export const CORE_VERSION = 1

const STAMP_PATTERN = /^[0-9]+:[0-9a-f]+:[0-9a-f]+$/

/**
 * Monta o runtime_stamp canônico a partir da versão do core e digests de configuração.
 */
export function buildRuntimeStamp({
  coreVersion = CORE_VERSION,
  configDigest,
  capabilitiesDigest,
}: { coreVersion?: number; configDigest: string; capabilitiesDigest: string } = ({} as any)): string {
  const stamp = `${coreVersion}:${configDigest}:${capabilitiesDigest}`
  if (!Number.isInteger(coreVersion) || coreVersion < 0 || !STAMP_PATTERN.test(stamp)) {
    throw new TypeError('runtime_stamp inválido: ' + stamp)
  }
  return stamp
}

/**
 * Faz o parsing estruturado de um runtime_stamp validando seu padrão canônico.
 */
export function parseRuntimeStamp(stamp: string): { coreVersion: number; configDigest: string; capabilitiesDigest: string } {
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

export type StaleIntent = {
  seq: number,
  step_id: string,
  effect_class: string,
  runtime_stamp: string,
}

/**
 * Localiza intenções abertas emitidas sob core_version incompatível com o atual.
 */
export function findStaleIntents(events: ReadonlyArray<Record<string,unknown>> = [], currentCoreVersion: number = CORE_VERSION): Array<StaleIntent> {
  const acceptedSeqs: Set<number> = new Set()

  if (Array.isArray(events)) {
    for (const ev of events) {
      if (
        ev &&
        typeof ev === 'object' &&
        ev.kind === 'decision' &&
        ev.data &&
        typeof ev.data === 'object'
      ) {
        const data: Record<string,unknown> = (ev.data as Record<string, unknown>)
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
 * @throws {StaleWorkflowVersionError}
 */
export function assertStampCurrent(events: ReadonlyArray<Record<string,unknown>> = [], currentCoreVersion: number = CORE_VERSION): void {
  const stale = findStaleIntents(events, currentCoreVersion)
  if (stale.length > 0) {
    throw new StaleWorkflowVersionError(stale, currentCoreVersion)
  }
}

/**
 * Grava decisão autorizando prosseguimento com versão desatualizada.
 */
export async function acceptStaleVersion(
  journal: { append(partial: Record<string,unknown>): Promise<Record<string,unknown>> },
  events: ReadonlyArray<Record<string,unknown>>,
  { source = 'operator', currentCoreVersion = CORE_VERSION }: { source?: string; currentCoreVersion?: number } = {},
): Promise<Record<string,unknown>|null> {
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

