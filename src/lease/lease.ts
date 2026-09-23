import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { AdeError, CoordinatorConflictError, LeaseAwaitingOperatorError } from '../journal/errors.ts'
import { getProcessStartTime, isProcessAlive } from './process-info.ts'

export type LeaseOwner = {
  pid: number
  start_time: string
  host: string
  engine_version: string
  acquired_at: string
}

export type Lease = {
  dir: string
  owner: LeaseOwner
  adopted: boolean
  previousOwner: null | Record<string, unknown>
  release: () => Promise<void>
}

export type LeaseOptions = {
  /** Caminho para o diretório da missão. */
  missionDir: string
  /** Intervalo em ms para batimentos do worker. */
  heartbeatMs?: number
  /** Tempo de vida em ms do lease para adoção. */
  ttlMs?: number
  /** PID do processo adquirente. */
  pid?: number
  /** Versão do engine. */
  engineVersion?: string
  /** Leitor de start_time do processo. */
  getStartTime?: (pid: number) => Promise<string | null>
  /** Checagem de processo ativo. */
  isAlive?: (pid: number) => boolean
  /** Provedor de relógio para acquired_at e primeiro heartbeat. */
  now?: () => Date
  /** Adota na hora dono comprovadamente morto no mesmo host. */
  adoptDeadOwnerWithinTtl?: boolean
}

/**
 * Lê e analisa o arquivo owner.json de um diretório de lease existente.
 */
function readOwner(leaseDir: string): Record<string,unknown>|null {
  try {
    const raw = fs.readFileSync(path.join(leaseDir, 'owner.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Calcula a idade em milissegundos do lease com base no mtime de heartbeat, owner.json ou pasta.
 * Usa Date.now() real para a decisão de TTL, garantindo que relógios injetados não alterem a expiração física.
 */
function leaseAgeMs(leaseDir: string): number {
  const heartbeatPath = path.join(leaseDir, 'heartbeat')
  try {
    return Date.now() - fs.statSync(heartbeatPath).mtimeMs
  } catch {
    try {
      return Date.now() - fs.statSync(path.join(leaseDir, 'owner.json')).mtimeMs
    } catch {
      try {
        return Date.now() - fs.statSync(leaseDir).mtimeMs
      } catch {
        return Infinity
      }
    }
  }
}

/**
 * Constrói o objeto de lease com controle de liberação idempotente.
 */
function createLeaseObject(leaseDir: string, owner: LeaseOwner, worker: Worker, adopted: boolean, previousOwner: null|Record<string,unknown>): Lease {
  let released = false
  const release: () => Promise<void> = async (): Promise<void> => {
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
 */
function requireOwnStartTime(startTime: string|null): string {
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
 * Valida se um objeto owner possui formato mínimo íntegro.
 */
function isValidOwner(owner: unknown): boolean {
  if (owner === null || typeof owner !== 'object') {
    return false
  }
  const candidate = (owner as Record<string, unknown>)
  return (
    Number.isInteger(candidate.pid) &&
    typeof candidate.pid === 'number' &&
    candidate.pid > 0 &&
    typeof candidate.start_time === 'string' &&
    candidate.start_time !== ''
  )
}

/**
 * Verifica se um dono é comprovadamente morto no mesmo host.
 */
async function ownerProvablyDead(owner: { pid: number; start_time: string; host?: unknown }, opts: Required<LeaseOptions>): Promise<boolean> {
  if (owner.host !== os.hostname()) {
    return false
  }
  try {
    if (!opts.isAlive(owner.pid)) {
      return true
    }
    const cur = await opts.getStartTime(owner.pid)
    return typeof cur === 'string' && cur !== owner.start_time
  } catch {
    return false
  }
}

/**
 * Move o lease expirado ou adotado para uma pasta temporária .stale-* e recria lease/.
 */
function renameForAdoption(leaseDir: string, opts: Required<LeaseOptions>, validOwner: Record<string,unknown>): { previousOwner: Record<string,unknown>; staleDir: string } {
  const staleDir = leaseDir + '.stale-' + opts.pid + '-' + opts.now().getTime()
  let renamed = false
  try {
    fs.renameSync(leaseDir, staleDir)
    renamed = true
    fs.mkdirSync(leaseDir)
  } catch {
    if (renamed) {
      // Perdemos a corrida: outro processo já recriou lease/ entre o rename e
      // o mkdir. Removemos só o staleDir desta tentativa; o lease/ do
      // vencedor não é nosso para tocar.
      fs.rmSync(staleDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    }
    throw new CoordinatorConflictError(
      (validOwner as { pid?: number | string } | null),
    )
  }

  return { previousOwner: validOwner, staleDir }
}

/**
 * Trata colisão quando a pasta lease/ já existe: avalia TTL do heartbeat e identidade do dono.
 */
async function handleExisting(leaseDir: string, opts: Required<LeaseOptions>): Promise<{ previousOwner: Record<string,unknown>; staleDir: string }> {
  const owner = readOwner(leaseDir)
  if (leaseAgeMs(leaseDir) <= opts.ttlMs) {
    if (
      opts.adoptDeadOwnerWithinTtl &&
      isValidOwner(owner) &&
      (await ownerProvablyDead(
        (owner as { pid: number, start_time: string, host?: unknown }),
        opts,
      ))
    ) {
      return renameForAdoption(
        leaseDir,
        opts,
        (owner as Record<string, unknown>),
      )
    }
    throw new CoordinatorConflictError(
      (owner as { pid?: number | string } | null),
    )
  }

  if (!isValidOwner(owner)) {
    throw new LeaseAwaitingOperatorError(null, 'owner inválido')
  }

  const validOwner = (owner as Record<string, unknown> & { pid: number, start_time: string })

  let alive: boolean = false
  try {
    alive = opts.isAlive(validOwner.pid)
  } catch {
    // Sem saber se o dono ainda vive, nunca se rouba o lease.
    throw new LeaseAwaitingOperatorError(
      validOwner,
      'estado do pid ' + validOwner.pid + ' indeterminado',
    )
  }

  if (alive) {
    let current: string|null = null
    try {
      current = await opts.getStartTime(validOwner.pid)
    } catch {
      throw new LeaseAwaitingOperatorError(
        validOwner,
        'start_time do pid ' + validOwner.pid + ' indeterminado',
      )
    }

    if (current === validOwner.start_time) {
      throw new LeaseAwaitingOperatorError(
        validOwner,
        'dono vivo com lease expirado',
      )
    }
  }

  return renameForAdoption(leaseDir, opts, validOwner)
}

/**
 * Grava credenciais de dono e inicia o worker de heartbeat.
 *
 * É deliberadamente síncrona e recebe o `start_time` já resolvido: qualquer
 * `await` entre a criação da pasta e a gravação de owner.json/heartbeat abriria
 * uma janela em que o lease parece órfão e outro processo poderia adotá-lo.
 */
function takeOwnership(leaseDir: string, opts: Required<LeaseOptions>, startTime: string): { owner: LeaseOwner; worker: Worker } {
  // Não limpa leaseDir em caso de falha: quem chama decide o que fazer com o
  // diretório, pois o significado de uma falha aqui difere entre uma aquisição
  // nova (diretório vazio, seguro remover) e uma adoção (pode precisar restaurar
  // o estado do dono anterior).

  const owner: LeaseOwner = {
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

  const worker = new Worker(new URL('./heartbeat-worker.ts', import.meta.url), {
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
 */
export async function acquireLease(options: LeaseOptions): Promise<Lease> {
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
    adoptDeadOwnerWithinTtl = false,
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
    typeof now !== 'function' ||
    typeof adoptDeadOwnerWithinTtl !== 'boolean'
  ) {
    throw new TypeError('opções de lease inválidas')
  }

  const resolvedOpts: Required<LeaseOptions> = {
    missionDir,
    heartbeatMs,
    ttlMs,
    pid,
    engineVersion,
    getStartTime,
    isAlive,
    now,
    adoptDeadOwnerWithinTtl,
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

  let adoption: { previousOwner: Record<string,unknown>; staleDir: string }|null = null

  try {
    fs.mkdirSync(leaseDir)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      adoption = await handleExisting(leaseDir, resolvedOpts)
    } else {
      throw err
    }
  }

  try {
    const { owner, worker } = takeOwnership(
      leaseDir,
      resolvedOpts,
      requireOwnStartTime(ownStartTime),
    )
    if (adoption !== null) {
      fs.rmSync(adoption.staleDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
      return createLeaseObject(leaseDir, owner, worker, true, adoption.previousOwner)
    }
    return createLeaseObject(leaseDir, owner, worker, false, null)
  } catch (err) {
    if (adoption !== null) {
      fs.rmSync(leaseDir, { recursive: true, force: true })
      try {
        fs.renameSync(adoption.staleDir, leaseDir)
      } catch {
        // se não conseguir restaurar, os dados ficam preservados em staleDir
      }
    } else {
      // Diretório recém-criado por esta chamada: seguro remover por inteiro.
      fs.rmSync(leaseDir, { recursive: true, force: true })
    }
    throw err
  }
}
