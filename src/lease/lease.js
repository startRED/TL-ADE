import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { AdeError, CoordinatorConflictError, LeaseAwaitingOperatorError } from '../journal/errors.js'
import { getProcessStartTime, isProcessAlive } from './process-info.js'

/**
 * @typedef {Object} LeaseOwner
 * @property {number} pid
 * @property {string} start_time
 * @property {string} host
 * @property {string} engine_version
 * @property {string} acquired_at
 */

/**
 * @typedef {Object} Lease
 * @property {string} dir
 * @property {LeaseOwner} owner
 * @property {boolean} adopted
 * @property {null | Record<string, unknown>} previousOwner
 * @property {() => Promise<void>} release
 */

/**
 * @typedef {Object} LeaseOptions
 * @property {string} missionDir Caminho para o diretório da missão.
 * @property {number} [heartbeatMs=2000] Intervalo em ms para batimentos do worker.
 * @property {number} [ttlMs=15000] Tempo de vida em ms do lease para adoção.
 * @property {number} [pid=process.pid] PID do processo adquirente.
 * @property {string} [engineVersion='0.1.0'] Versão do engine.
 * @property {(pid: number) => Promise<string | null>} [getStartTime=getProcessStartTime] Leitor de start_time do processo.
 * @property {(pid: number) => boolean} [isAlive=isProcessAlive] Checagem de processo ativo.
 * @property {() => Date} [now=() => new Date()] Provedor de relógio para acquired_at e primeiro heartbeat.
 */

/**
 * Lê e analisa o arquivo owner.json de um diretório de lease existente.
 * @param {string} leaseDir
 * @returns {Record<string, unknown> | null}
 */
function readOwner(leaseDir) {
  try {
    const raw = fs.readFileSync(path.join(leaseDir, 'owner.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Obtém o mtime em milissegundos do heartbeat, ou fallback para owner.json, ou fallback para a pasta leaseDir.
 * @param {string} leaseDir
 * @returns {number}
 */
function getLeaseMtimeMs(leaseDir) {
  const heartbeatPath = path.join(leaseDir, 'heartbeat')
  try {
    return fs.statSync(heartbeatPath).mtimeMs
  } catch {
    try {
      return fs.statSync(path.join(leaseDir, 'owner.json')).mtimeMs
    } catch {
      try {
        return fs.statSync(leaseDir).mtimeMs
      } catch {
        return 0
      }
    }
  }
}

/**
 * Constrói o objeto de lease com controle de liberação idempotente.
 * @param {string} leaseDir
 * @param {LeaseOwner} owner
 * @param {Worker} worker
 * @param {boolean} adopted
 * @param {null | Record<string, unknown>} previousOwner
 * @returns {Lease}
 */
function createLeaseObject(leaseDir, owner, worker, adopted, previousOwner) {
  let released = false
  /** @type {() => Promise<void>} */
  const release = async () => {
    if (released) {
      return
    }
    released = true
    await worker.terminate()
    fs.rmSync(leaseDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  }

  return {
    dir: leaseDir,
    owner,
    adopted,
    previousOwner,
    release,
  }
}

/**
 * Exige o start_time do processo adquirente já resolvido: sem identidade em
 * mãos não se reivindica lease nenhum.
 * @param {string | null} startTime
 * @returns {string}
 */
function requireOwnStartTime(startTime) {
  if (startTime === null) {
    throw new AdeError(
      'process_info_unavailable',
      'start_time do próprio processo indisponível',
      3,
    )
  }
  return startTime
}

/**
 * Trata colisão quando a pasta lease/ já existe: avalia TTL do heartbeat e identidade do dono.
 * @param {string} leaseDir
 * @param {Required<LeaseOptions>} opts
 * @param {string | null} ownStartTime start_time do adquirente, resolvido antes de qualquer reivindicação.
 * @returns {Promise<Lease>}
 */
async function handleExisting(leaseDir, opts, ownStartTime) {
  const previousOwner = readOwner(leaseDir)
  const mtimeMs = getLeaseMtimeMs(leaseDir)
  // A decisão de TTL usa sempre o relógio real: `now` injetado cobre só
  // acquired_at e o primeiro heartbeat, nunca o cálculo de idade do lease.
  const ageMs = Date.now() - mtimeMs

  if (ageMs <= opts.ttlMs) {
    throw new CoordinatorConflictError(
      /** @type {{ pid?: number | string } | null} */ (previousOwner),
    )
  }

  const prevPid =
    previousOwner && typeof previousOwner.pid === 'number' && previousOwner.pid > 0
      ? previousOwner.pid
      : null

  if (prevPid !== null) {
    let alive = false
    try {
      alive = opts.isAlive(prevPid)
    } catch (err) {
      throw new LeaseAwaitingOperatorError(
        previousOwner,
        'falha ao verificar se processo dono está vivo: ' +
          (err && typeof err === 'object' && 'message' in err ? err.message : String(err)),
      )
    }

    if (alive) {
      /** @type {string | null} */
      let currentStartTime = null
      try {
        currentStartTime = await opts.getStartTime(prevPid)
      } catch (err) {
        throw new LeaseAwaitingOperatorError(
          previousOwner,
          'falha ao obter start_time do processo dono: ' +
            (err && typeof err === 'object' && 'message' in err ? err.message : String(err)),
        )
      }

      if (currentStartTime === null) {
        // Identidade do dono anterior não pôde ser confirmada: nunca adota na dúvida.
        throw new LeaseAwaitingOperatorError(
          previousOwner,
          'lease expirado mas identidade do processo dono anterior não pôde ser confirmada',
        )
      }

      const prevStartTime =
        previousOwner &&
        typeof previousOwner.start_time === 'string' &&
        previousOwner.start_time !== ''
          ? previousOwner.start_time
          : null

      if (prevStartTime === null || currentStartTime === prevStartTime) {
        // Processo dono continua vivo com o mesmo start_time (ou sem start_time para desambiguação)
        throw new LeaseAwaitingOperatorError(
          previousOwner,
          'lease expirado mas processo dono anterior ainda está ativo',
        )
      }
      // PID reciclado: processo com aquele PID existe mas start_time difere (dono original morreu)
    }
  }

  // A identidade do novo dono já tem de estar resolvida aqui: entre a
  // reivindicação e a gravação de owner.json não pode haver nenhum await.
  const startTime = requireOwnStartTime(ownStartTime)

  // Reivindicação atômica do lease expirado: renomeia o diretório antigo para um
  // nome único antes de recriá-lo. Só quem vencer o rename cria o novo diretório;
  // quem perder encontra o caminho ausente ou já reocupado e trata como conflito.
  const staleDir = `${leaseDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    fs.renameSync(leaseDir, staleDir)
  } catch {
    throw new CoordinatorConflictError(readOwner(leaseDir))
  }

  try {
    fs.mkdirSync(leaseDir)
  } catch {
    // Outro processo recriou o diretório entre o rename e o mkdir: conflito.
    fs.rmSync(staleDir, { recursive: true, force: true })
    throw new CoordinatorConflictError(readOwner(leaseDir))
  }

  try {
    const { owner, worker } = takeOwnership(leaseDir, opts, startTime)
    fs.rmSync(staleDir, { recursive: true, force: true })
    return createLeaseObject(leaseDir, owner, worker, true, previousOwner)
  } catch (err) {
    // Falhou depois de reivindicar: remove só o que esta tentativa criou agora e
    // restaura o estado anterior renomeado, sem perder os dados do dono expirado.
    fs.rmSync(leaseDir, { recursive: true, force: true })
    try {
      fs.renameSync(staleDir, leaseDir)
    } catch {
      // se não conseguir restaurar, os dados ficam preservados em staleDir
    }
    throw err
  }
}

/**
 * Grava credenciais de dono e inicia o worker de heartbeat.
 *
 * É deliberadamente síncrona e recebe o `start_time` já resolvido: qualquer
 * `await` entre a criação da pasta e a gravação de owner.json/heartbeat abriria
 * uma janela em que o lease parece órfão e outro processo poderia adotá-lo.
 * @param {string} leaseDir
 * @param {Required<LeaseOptions>} opts
 * @param {string} startTime
 * @returns {{ owner: LeaseOwner, worker: Worker }}
 */
function takeOwnership(leaseDir, opts, startTime) {
  // Não limpa leaseDir em caso de falha: quem chama decide o que fazer com o
  // diretório, pois o significado de uma falha aqui difere entre uma aquisição
  // nova (diretório vazio, seguro remover) e uma adoção (pode precisar restaurar
  // o estado do dono anterior).

  /** @type {LeaseOwner} */
  const owner = {
    pid: opts.pid,
    start_time: startTime,
    host: os.hostname(),
    engine_version: opts.engineVersion,
    acquired_at: opts.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }

  const ownerPath = path.join(leaseDir, 'owner.json')
  const heartbeatPath = path.join(leaseDir, 'heartbeat')

  fs.writeFileSync(ownerPath, JSON.stringify(owner))
  fs.writeFileSync(heartbeatPath, opts.now().toISOString())

  const worker = new Worker(new URL('./heartbeat-worker.js', import.meta.url), {
    workerData: {
      heartbeatPath,
      heartbeatMs: opts.heartbeatMs,
    },
  })
  worker.unref()

  return { owner, worker }
}

/**
 * Adquire lease de coordenação exclusivo na pasta da missão (s5).
 * @param {LeaseOptions} options
 * @returns {Promise<Lease>}
 */
export async function acquireLease(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('opções de lease inválidas')
  }

  const {
    missionDir,
    heartbeatMs = 2000,
    ttlMs = 15000,
    pid = process.pid,
    engineVersion = '0.1.0',
    getStartTime = getProcessStartTime,
    isAlive = isProcessAlive,
    now = () => new Date(),
  } = options

  if (
    typeof missionDir !== 'string' ||
    missionDir === '' ||
    typeof engineVersion !== 'string' ||
    engineVersion === '' ||
    !Number.isInteger(heartbeatMs) ||
    heartbeatMs <= 0 ||
    !Number.isInteger(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof getStartTime !== 'function' ||
    typeof isAlive !== 'function' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('opções de lease inválidas')
  }

  /** @type {Required<LeaseOptions>} */
  const resolvedOpts = {
    missionDir,
    heartbeatMs,
    ttlMs,
    pid,
    engineVersion,
    getStartTime,
    isAlive,
    now,
  }

  fs.mkdirSync(missionDir, { recursive: true })
  const leaseDir = path.join(missionDir, 'lease')

  // A identidade do dono é resolvida ANTES de criar a pasta lease/: se essa
  // leitura demorasse com a pasta já criada, outro processo veria um lease sem
  // owner.json nem heartbeat, o julgaria expirado e adotaria — e as duas
  // aquisições teriam sucesso.
  const ownStartTime = await resolvedOpts.getStartTime(resolvedOpts.pid)

  if (ownStartTime === null && !fs.existsSync(leaseDir)) {
    // Sem lease em disputa e sem identidade: recusa sem criar nada.
    requireOwnStartTime(ownStartTime)
  }

  try {
    fs.mkdirSync(leaseDir)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      return handleExisting(leaseDir, resolvedOpts, ownStartTime)
    }
    throw err
  }

  try {
    const { owner, worker } = takeOwnership(
      leaseDir,
      resolvedOpts,
      requireOwnStartTime(ownStartTime),
    )
    return createLeaseObject(leaseDir, owner, worker, false, null)
  } catch (err) {
    // Diretório recém-criado por esta chamada: seguro remover por inteiro.
    fs.rmSync(leaseDir, { recursive: true, force: true })
    throw err
  }
}
