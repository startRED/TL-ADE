// @ts-check
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'

/**
 * Controle cooperativo da missão: RUNNING → DRAINING → STOPPED → RUNNING.
 * O estado vem só dos eventos `mission_control` do journal; o pedido do operador é um arquivo
 * durável e exclusivo que o escritor ativo do journal consome (ADR de escritor único).
 */

const ACTIONS = ['pause', 'resume']
const REQUEST_FILE = 'control-request.json'
const MISSION_ID_RE = /^[A-Za-z0-9._-]+$/

function controlEvents(events: Array<Record<string, any>>): Array<Record<string, any>> {
  return events.filter((e) => e.kind === 'mission_control')
}

/**
 * Story sob controle humano: último `human_takeover` sem `human_release` posterior.
 */
export function activeTakeover(events: Array<Record<string, any>>): string | null {
  const last = [...events].reverse().find((e) => e.kind === 'human_takeover' || e.kind === 'human_release')
  return last?.kind === 'human_takeover' ? last.data?.unit ?? null : null
}

function readRequest(missionDir: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(missionDir, REQUEST_FILE), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new AdeError('control_request_corrupted', `pedido de controle ilegível: ${err instanceof Error ? err.message : err}`, 2)
  }
}

/**
 * Pedido já aplicado pelo journal (pausa que chegou a STOPPED, retomada que voltou a RUNNING).
 */
function isConsumed(request: Record<string, any>, ctl: Array<Record<string, any>>) {
  const target = request.action === 'pause' ? 'STOPPED' : 'RUNNING'
  return ctl.some((e) => e.data?.request_id === request.request_id && e.data?.state === target)
}

function snapshot(missionDir: string): { state: 'RUNNING' | 'DRAINING' | 'STOPPED'; events: Array<Record<string, any>>; request: Record<string, any> | null } {
  const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
  const ctl = controlEvents(events)
  const state = ctl.at(-1)?.data?.state ?? 'RUNNING'
  const raw = readRequest(missionDir)
  return { state, events, request: raw && !isConsumed(raw, ctl) ? raw : null }
}

export function readMissionControl({ missionDir }: { missionDir: string }): { state: 'RUNNING' | 'DRAINING' | 'STOPPED'; requested_action: string | null; request_id: string | null } {
  const { state, request } = snapshot(missionDir)
  return { state, requested_action: request?.action ?? null, request_id: request?.request_id ?? null }
}

/**
 * Remove o pedido consumido, só se ainda for o mesmo (outro pedido não é apagado por engano).
 */
export function clearControlRequest(missionDir: string, requestId: string) {
  const current = readRequest(missionDir)
  if (current?.request_id === requestId) fs.rmSync(path.join(missionDir, REQUEST_FILE), { force: true })
}

/**
 * Registra um pedido durável de pausa ou retomada. Pedido repetido devolve o mesmo `request_id`;
 * transição inválida lança `control_invalid_transition` sem tocar o journal.
 */
export async function requestMissionControl({ repoDir, missionId, action, expectedDigest, source }: { repoDir: string; missionId: string; action: 'pause' | 'resume'; expectedDigest: string; source: string }): Promise<{ request_id: string | null; action: string; state: string; idempotent: boolean }> {
  if (!ACTIONS.includes(action)) throw new AdeError('control_action_invalid', `ação de controle inválida: ${action}`, 4)
  if (typeof missionId !== 'string' || !MISSION_ID_RE.test(missionId)) {
    throw new AdeError('control_mission_invalid', `missão inválida: ${missionId}`, 4)
  }
  if (typeof source !== 'string' || source.length === 0) throw new AdeError('control_source_invalid', 'origem obrigatória', 4)
  const missionDir = path.join(path.resolve(repoDir), '.ade', 'missions', missionId)
  let plan
  try {
    plan = JSON.parse(fs.readFileSync(path.join(missionDir, 'plan.json'), 'utf8'))
  } catch (err) {
    throw new AdeError('control_mission_invalid', `plano da missão ilegível: ${err instanceof Error ? err.message : err}`, 4)
  }
  if (digest16(plan) !== expectedDigest) {
    throw new AdeError('control_digest_mismatch', 'digest do plano divergente: recarregue a missão', 4)
  }

  // Duas tentativas: a segunda só existe para trocar um pedido já consumido pelo journal.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { state, events, request } = snapshot(missionDir)
    if (request) {
      if (request.action === action) return { request_id: request.request_id, action, state, idempotent: true }
      throw new AdeError('control_invalid_transition', `pedido de ${request.action} pendente`, 5, { state })
    }
    if (action === 'pause' && state !== 'RUNNING') {
      const last = controlEvents(events).at(-1)
      return { request_id: last?.data?.request_id ?? null, action, state, idempotent: true }
    }
    if (action === 'resume' && state === 'RUNNING') return { request_id: null, action, state, idempotent: true }
    if (action === 'resume' && activeTakeover(events)) {
      throw new AdeError('control_invalid_transition', 'operador no controle: devolva o controle antes de retomar', 5, { state })
    }
    if (action === 'resume' && state === 'DRAINING') {
      throw new AdeError('control_invalid_transition', 'retomada exige a missão em STOPPED', 5, { state })
    }

    const record = {
      format_version: 1,
      request_id: `ctl-${randomUUID()}`,
      mission_id: missionId,
      action,
      source,
      expected_digest: expectedDigest,
      requested_at: new Date().toISOString(),
    }
    const finalPath = path.join(missionDir, REQUEST_FILE)
    const tmpPath = `${finalPath}.${record.request_id}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8')
    try {
      // link é atômico e exclusivo: de pedidos concorrentes, só um vira o pedido pendente.
      fs.linkSync(tmpPath, finalPath)
      return { request_id: record.request_id, action, state, idempotent: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      const existing = readRequest(missionDir)
      if (existing && isConsumed(existing, controlEvents(events))) clearControlRequest(missionDir, existing.request_id)
    } finally {
      fs.rmSync(tmpPath, { force: true })
    }
  }
  throw new AdeError('control_request_conflict', 'pedido de controle concorrente não resolvido', 5)
}

/**
 * Drena a missão: registra DRAINING, para de reivindicar trabalho, salva o ponto seguro e
 * registra STOPPED com a referência do checkpoint.
 */
export async function drainMission({ journal, checkpoint, stopClaiming, reason, requestId = null }: {
    journal: { append: (e: Record<string, unknown>) => Promise<Record<string, unknown>> }
    checkpoint: () => Promise<string>
    stopClaiming: () => void
    reason: string
    requestId?: string | null
  }): Promise<{ state: 'STOPPED'; checkpoint_ref: string }> {
  if (typeof reason !== 'string' || reason.length === 0) throw new AdeError('control_reason_missing', 'motivo da drenagem obrigatório', 4)
  const data = { action: 'pause', request_id: requestId, reason }
  await journal.append({ kind: 'mission_control', data: { state: 'DRAINING', ...data } })
  stopClaiming()
  const checkpointRef = await checkpoint()
  await journal.append({ kind: 'mission_control', data: { state: 'STOPPED', ...data, checkpoint_ref: checkpointRef } })
  return { state: 'STOPPED', checkpoint_ref: checkpointRef }
}

/**
 * Converte sinais de encerramento (desligamento, atualização, reinício) em pedido de drenagem.
 */
export function installShutdownDrain(target: { on: Function; removeListener: Function }, onSignal: (signal: string) => void): { reason: () => string | null; dispose: () => void } {
  
  let reason: string | null = null
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const handler = () => {
      if (reason) return
      reason = `shutdown:${signal}`
      onSignal?.(signal)
    }
    target.on(signal, handler)
    return ([signal, handler])
  })
  return {
    reason: () => reason,
    dispose: () => {
      for (const [signal, handler] of handlers) target.removeListener(signal, handler)
    },
  }
}
