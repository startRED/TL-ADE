// @ts-check
import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { activeTakeover, readMissionControl, requestMissionControl } from '../engine/control.js'
import { findStoryStarted } from '../engine/resume.js'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { openJournal, readJournal } from '../journal/journal.ts'
import { acquireLease } from '../lease/lease.ts'
import { getProcessStartTime } from '../lease/process-info.ts'
import { resolveBinary } from '../runner/resolve-binary.ts'
import { createTakeoverSession, loadPtyAdapter } from './pty.js'

/**
 * Takeover e devolução de controle pelo painel. Com a missão STOPPED não há escritor ativo: o
 * painel adquire o lease da missão, vira o escritor único enquanto o operador controla e registra
 * cada passo no journal antes do efeito. Desconexão do navegador não devolve o controle.
 */

const ID_RE = /^[A-Za-z0-9._-]+$/

/**
 * @typedef {{
 *   ptyAdapter?: { spawn: Function },
 *   resolveBinary?: (cmd: string) => { exe: string, prefixArgs: string[] },
 *   platform?: string,
 *   execFileSync?: Function,
 *   isAlive?: (pid: number) => boolean,
 * }} TerminalDeps
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new AdeError('control_body_invalid', `${field} inválido`, 4)
  return value
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameToken(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** @type {Promise<string | null> | null} */
let ownStartTime = null

/**
 * O start_time do próprio processo não muda, e no Windows cada leitura custa um PowerShell
 * (~1 s): o processo o lê uma vez. Pid alheio (dono anterior do lease) é sempre relido.
 *
 * @param {number} pid
 */
function startTimeOf(pid) {
  if (pid !== process.pid) return getProcessStartTime(pid)
  ownStartTime ??= getProcessStartTime(pid).catch((err) => {
    ownStartTime = null
    throw err
  })
  return ownStartTime
}

/**
 * @param {{ repoDir: string, terminal?: TerminalDeps }} input
 */
export function createInterventionController({ repoDir, terminal = {} }) {
  /** @type {Map<string, { session: ReturnType<typeof createTakeoverSession>, journal: import('../journal/journal.ts').Journal, lease: { release: () => Promise<void> }, socket: import('node:net').Socket | null }>} */
  const sessions = new Map()
  let queue = Promise.resolve()
  // Leitura antecipada: o takeover não espera o PowerShell. A falha fica para o takeover, que relê.
  startTimeOf(process.pid).catch((err) => {
    process.emitWarning(`start_time do painel indisponível: ${err instanceof Error ? err.message : err}`)
  })

  /**
   * Ações do painel em série: duas requisições simultâneas não disputam lease nem journal.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const run = queue.then(fn)
    // A fila só ordena; o erro segue para quem chamou por `run`.
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * @param {any} body
   */
  function loadMission(body) {
    const missionId = requireId(body?.mission_id, 'mission_id')
    const storyId = requireId(body?.story_id, 'story_id')
    const missionDir = path.join(repoDir, '.ade', 'missions', missionId)
    let plan
    try {
      plan = JSON.parse(fs.readFileSync(path.join(missionDir, 'plan.json'), 'utf8'))
    } catch (err) {
      throw new AdeError('control_mission_invalid', `plano da missão ilegível: ${err instanceof Error ? err.message : err}`, 4)
    }
    if (digest16(plan) !== body.digest) throw new AdeError('control_digest_mismatch', 'digest do plano divergente: recarregue a missão', 4)
    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    return { missionId, storyId, missionDir, digest: /** @type {string} */ (body.digest), events }
  }

  /**
   * @param {{ session: ReturnType<typeof createTakeoverSession> }} entry
   */
  const describe = ({ session }) => ({
    mission_id: session.mission,
    story_id: session.story,
    session_ref: session.sessionRef,
    worktree: session.worktree,
    terminal_token: session.token,
  })

  /** @param {any} body */
  const takeover = (body) => serial(async () => {
    const { missionId, storyId, missionDir, events } = loadMission(body)
    const key = `${missionId}/${storyId}`
    const attached = sessions.get(key)
    if (attached) return describe(attached)

    const ctl = readMissionControl({ missionDir })
    if (ctl.state !== 'STOPPED' || ctl.requested_action) {
      throw new AdeError('control_invalid_transition', 'takeover exige a missão em STOPPED sem pedido pendente', 5, { state: ctl.state })
    }
    const held = activeTakeover(events)
    if (held && held !== storyId) throw new AdeError('control_invalid_transition', `story ${held} já está sob controle humano`, 5)
    const started = findStoryStarted(events, storyId)
    const sessionRef = [...events].reverse().find((e) =>
      e.kind === 'step_intent' && e.effect_class === 'model_call' && e.data?.unit === storyId && e.session_ref)?.session_ref
    if (!started || !sessionRef || !fs.existsSync(started.worktree_dir)) {
      throw new AdeError('takeover_unavailable', `story ${storyId} sem sessão retomável no worktree`, 5)
    }
    const runtimeStamp = events.at(-1)?.runtime_stamp
    const ptyAdapter = terminal.ptyAdapter ?? await loadPtyAdapter()
    const command = (terminal.resolveBinary ?? resolveBinary)('claude')

    const lease = await acquireLease({ missionDir, getStartTime: startTimeOf })
    const journal = openJournal({ missionDir, runtimeStamp })
    try {
      await journal.append({
        kind: 'human_takeover',
        effect_class: 'human_takeover',
        source: 'panel',
        session_ref: sessionRef,
        worktree: started.worktree_dir,
        data: { unit: storyId, reopened: held === storyId },
      })
      let session
      try {
        session = createTakeoverSession({
          mission: missionId,
          story: storyId,
          sessionRef,
          worktree: started.worktree_dir,
          ptyAdapter,
          command,
          platform: terminal.platform,
          execFileSync: terminal.execFileSync,
          isAlive: terminal.isAlive,
        })
      } catch (err) {
        // Reabertura falha sem encerrar o takeover durável: só a ação explícita de release o devolve.
        if (held !== storyId) await journal.append({
          kind: 'human_release',
          effect_class: 'human_release',
          source: 'panel',
          data: { unit: storyId, reason: 'terminal_failed', checkpoint_ref: `journal:${journal.lastSeq}` },
        })
        throw new AdeError('takeover_terminal_failed', `terminal não abriu: ${err instanceof Error ? err.message : err}`, 5)
      }
      const entry = { session, journal, lease, socket: null }
      sessions.set(key, entry)
      return describe(entry)
    } catch (err) {
      await journal.close()
      await lease.release()
      throw err
    }
  })

  /** @param {any} body */
  const release = (body) => serial(async () => {
    const { missionId, storyId, digest, events } = loadMission(body)
    const key = `${missionId}/${storyId}`
    if (activeTakeover(events) !== storyId) throw new AdeError('control_invalid_transition', `story ${storyId} não está sob controle humano`, 5)
    const entry = sessions.get(key)
    if (!entry) throw new AdeError('takeover_not_attached', 'terminal não está aberto neste painel: assuma de novo para reabri-lo', 5)

    const killed = await entry.session.close()
    if (killed.terminated_by === 'failed') {
      await entry.journal.append({
        kind: 'takeover_terminate_failed',
        source: 'panel',
        data: { unit: storyId, pid: killed.pid, error: killed.error },
      })
      throw new AdeError('takeover_terminate_failed', `terminal não encerrou (${killed.error}): intervenção necessária`, 5)
    }
    entry.socket?.destroy()
    const checkpointRef = `journal:${entry.journal.lastSeq}`
    await entry.journal.append({
      kind: 'human_release',
      effect_class: 'human_release',
      source: 'panel',
      data: { unit: storyId, checkpoint_ref: checkpointRef, terminated_by: killed.terminated_by },
    })
    sessions.delete(key)
    await entry.journal.close()
    await entry.lease.release()
    // A retomada é um pedido durável: o escritor da missão revalida antes de voltar a RUNNING.
    const resumed = await requestMissionControl({ repoDir, missionId, action: 'resume', expectedDigest: digest, source: 'panel' })
    return { state: resumed.state, checkpoint_ref: checkpointRef, request_id: resumed.request_id }
  })

  /**
   * Localiza a sessão de terminal pelo token próprio do takeover.
   *
   * @param {{ token: string | null, mission: string | null, story: string | null }} input
   */
  function findTerminal({ token, mission, story }) {
    if (!token) return null
    for (const entry of sessions.values()) {
      if (sameToken(entry.session.token, token)) {
        return entry.session.mission === mission && entry.session.story === story ? entry : null
      }
    }
    return null
  }

  /** Servidor encerrando: fecha o terminal sem devolver o controle, que segue no journal. */
  async function closeAll() {
    await queue
    for (const entry of sessions.values()) {
      entry.socket?.destroy()
      await entry.session.close()
      await entry.journal.close()
      await entry.lease.release()
    }
    sessions.clear()
  }

  return { takeover, release, findTerminal, closeAll }
}
