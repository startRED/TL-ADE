import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError, CoordinatorConflictError, LeaseAwaitingOperatorError } from '../src/journal/errors.js'
import { acquireLease } from '../src/lease/lease.js'

interface LeaseOwner {
  pid: number
  start_time: string
  host: string
  engine_version: string
  acquired_at: string
}

interface Lease {
  dir: string
  owner: LeaseOwner
  adopted: boolean
  previousOwner: null | Record<string, unknown>
  release(): Promise<void>
}

type AcquireLeaseFn = (options: {
  missionDir: string
  heartbeatMs?: number
  ttlMs?: number
  pid?: number
  engineVersion?: string
  getStartTime?: (pid: number) => Promise<string | null>
  isAlive?: (pid: number) => boolean
  now?: () => Date
}) => Promise<Lease>

const acquire = acquireLease as unknown as AcquireLeaseFn

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

function createMissionDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-lease-'))
  tmpDirs.push(dir)
  return dir
}

describe('lease heartbeat', () => {
  // AC4: Dado um lease com heartbeatMs:50, quando a thread principal fica bloqueada por 400 ms em laço síncrono,
  // então o conteúdo de heartbeat lido logo após o bloqueio difere do lido antes (o batimento vem do worker,
  // com o relógio real dele, e não do now injetado).
  test('heartbeat_is_rewritten_by_worker_thread_while_main_loop_is_blocked', async () => {
    const missionDir = createMissionDir()
    const lease = await acquire({
      missionDir,
      heartbeatMs: 50,
      ttlMs: 1000,
      getStartTime: async () => 'T0',
    })

    try {
      const heartbeatPath = path.join(missionDir, 'lease', 'heartbeat')
      const initial = readFileSync(heartbeatPath, 'utf8')

      // Esperar o worker subir: poll com setTimeout(25) até o conteúdo de heartbeat mudar uma vez (limite 5 s)
      const deadline = Date.now() + 5000
      let updated = initial
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        const current = readFileSync(heartbeatPath, 'utf8')
        if (current !== initial) {
          updated = current
          break
        }
      }
      expect(updated).not.toBe(initial)

      // Bloqueio síncrono de 400 ms na thread principal
      const beforeBlock = readFileSync(heartbeatPath, 'utf8')
      const end = Date.now() + 400
      while (Date.now() < end) {}
      const afterBlock = readFileSync(heartbeatPath, 'utf8')

      expect(afterBlock).not.toBe(beforeBlock)
    } finally {
      await lease.release()
    }
  })

  test('lease_is_released_after_holder_crash_without_graceful_unlock', async () => {
    // Cenário C2 / R2: dono morreu sem liberar; adotar após TTL vencido e processo inexistente
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    mkdirSync(leaseDir, { recursive: true })

    const oldOwner: LeaseOwner = {
      pid: 99999,
      start_time: '2026-09-17T10:00:00.000Z',
      host: 'OLD_HOST',
      engine_version: '0.1.0',
      acquired_at: '2026-09-17T10:00:00Z',
    }
    const ownerPath = path.join(leaseDir, 'owner.json')
    const heartbeatPath = path.join(leaseDir, 'heartbeat')
    writeFileSync(ownerPath, JSON.stringify(oldOwner))
    writeFileSync(heartbeatPath, new Date(Date.now() - 60000).toISOString())

    // Envelhecer o heartbeat para 60 segundos atrás (TTL é 15000 ms)
    const past = new Date(Date.now() - 60000)
    utimesSync(heartbeatPath, past, past)

    // 1. Processo morto (isAlive: false) -> Adota o lease com adopted: true e previousOwner correto
    const adoptedLease = await acquire({
      missionDir,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async () => 'T_NEW',
      isAlive: () => false,
    })

    try {
      expect(adoptedLease.adopted).toBe(true)
      expect(adoptedLease.previousOwner).toEqual(oldOwner)
      expect(adoptedLease.owner.pid).toBe(process.pid)
      expect(adoptedLease.owner.start_time).toBe('T_NEW')
      const updatedOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as LeaseOwner
      expect(updatedOwner.pid).toBe(process.pid)
    } finally {
      await adoptedLease.release()
    }

    // 2. PID reciclado: processo com aquele PID existe (isAlive: true), mas com start_time diferente
    const missionDirRecycled = createMissionDir()
    const leaseDirRecycled = path.join(missionDirRecycled, 'lease')
    mkdirSync(leaseDirRecycled, { recursive: true })
    writeFileSync(
      path.join(leaseDirRecycled, 'owner.json'),
      JSON.stringify({
        pid: 88888,
        start_time: 'START_ORIGINAL',
        host: 'HOST_X',
        engine_version: '0.1.0',
        acquired_at: '2026-09-17T09:00:00Z',
      }),
    )
    const hbRecycled = path.join(leaseDirRecycled, 'heartbeat')
    writeFileSync(hbRecycled, past.toISOString())
    utimesSync(hbRecycled, past, past)

    const recycledLease = await acquire({
      missionDir: missionDirRecycled,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async (pid) => (pid === 88888 ? 'START_RECYCLED' : 'T_NEW_2'),
      isAlive: (pid) => pid === 88888,
    })

    try {
      expect(recycledLease.adopted).toBe(true)
      expect(recycledLease.previousOwner?.pid).toBe(88888)
      expect(recycledLease.previousOwner?.start_time).toBe('START_ORIGINAL')
      expect(recycledLease.owner.start_time).toBe('T_NEW_2')
    } finally {
      await recycledLease.release()
    }

    // 3. Processo VIVO com o MESMO start_time após TTL -> awaiting_operator (exit 3)
    const missionDirSame = createMissionDir()
    const leaseDirSame = path.join(missionDirSame, 'lease')
    mkdirSync(leaseDirSame, { recursive: true })
    writeFileSync(
      path.join(leaseDirSame, 'owner.json'),
      JSON.stringify({
        pid: 77777,
        start_time: 'START_SAME',
        host: 'HOST_Y',
        engine_version: '0.1.0',
        acquired_at: '2026-09-17T08:00:00Z',
      }),
    )
    const hbSame = path.join(leaseDirSame, 'heartbeat')
    writeFileSync(hbSame, past.toISOString())
    utimesSync(hbSame, past, past)

    let operatorErr: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir: missionDirSame,
        ttlMs: 15000,
        getStartTime: async (pid) => (pid === 77777 ? 'START_SAME' : 'T_NEW_3'),
        isAlive: (pid) => pid === 77777,
      })
    } catch (err) {
      operatorErr = err as LeaseAwaitingOperatorError
    }
    expect(operatorErr).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(operatorErr).toBeInstanceOf(AdeError)
    expect(operatorErr?.code).toBe('awaiting_operator')
    expect(operatorErr?.exitCode).toBe(3)
    expect((operatorErr?.details?.owner as Record<string, unknown>)?.pid).toBe(77777)

    // 4. Heartbeat AINDA FRESCO (TTL não expirou) mesmo que o processo esteja morto -> CoordinatorConflictError (exit 5)
    const missionDirFresh = createMissionDir()
    const leaseDirFresh = path.join(missionDirFresh, 'lease')
    mkdirSync(leaseDirFresh, { recursive: true })
    writeFileSync(
      path.join(leaseDirFresh, 'owner.json'),
      JSON.stringify({
        pid: 66666,
        start_time: 'START_FRESH',
        host: 'HOST_Z',
        engine_version: '0.1.0',
        acquired_at: '2026-09-17T12:00:00Z',
      }),
    )
    const hbFresh = path.join(leaseDirFresh, 'heartbeat')
    writeFileSync(hbFresh, new Date().toISOString())

    let conflictErr: CoordinatorConflictError | null = null
    try {
      await acquire({
        missionDir: missionDirFresh,
        ttlMs: 15000,
        isAlive: () => false,
      })
    } catch (err) {
      conflictErr = err as CoordinatorConflictError
    }
    expect(conflictErr).toBeInstanceOf(CoordinatorConflictError)
    expect(conflictErr).toBeInstanceOf(AdeError)
    expect(conflictErr?.code).toBe('coordinator_conflict')
    expect(conflictErr?.exitCode).toBe(5)

    // 5. Lease expirado com owner.json ausente/inválido -> adotado com previousOwner: null
    const missionDirCorrupt = createMissionDir()
    const leaseDirCorrupt = path.join(missionDirCorrupt, 'lease')
    mkdirSync(leaseDirCorrupt, { recursive: true })
    const hbCorrupt = path.join(leaseDirCorrupt, 'heartbeat')
    writeFileSync(hbCorrupt, past.toISOString())
    utimesSync(hbCorrupt, past, past)

    const corruptLease = await acquire({
      missionDir: missionDirCorrupt,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async () => 'T_NEW_4',
    })
    try {
      expect(corruptLease.adopted).toBe(true)
      expect(corruptLease.previousOwner).toBeNull()
    } finally {
      await corruptLease.release()
    }
  })

  test('lease_ttl_expiry_uses_real_clock_not_injected_now', async () => {
    // Rodada de revisão: `now` injetado não pode mascarar a expiração real do TTL.
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    mkdirSync(leaseDir, { recursive: true })
    writeFileSync(
      path.join(leaseDir, 'owner.json'),
      JSON.stringify({
        pid: 55555,
        start_time: 'OLD',
        host: 'HOST_OLD',
        engine_version: '0.1.0',
        acquired_at: '2000-01-01T00:00:00Z',
      }),
    )
    const heartbeatPath = path.join(leaseDir, 'heartbeat')
    const past = new Date(Date.now() - 60000)
    writeFileSync(heartbeatPath, past.toISOString())
    utimesSync(heartbeatPath, past, past)

    // `now` congelado no ano 2000: se o cálculo de idade usasse `now` em vez do
    // relógio real, a idade calculada seria negativa e o lease pareceria fresco.
    const frozenNow = () => new Date('2000-01-01T00:00:00Z')

    const lease = await acquire({
      missionDir,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async () => 'T_NEW',
      isAlive: () => false,
      now: frozenNow,
    })
    try {
      expect(lease.adopted).toBe(true)
    } finally {
      await lease.release()
    }
  })

  test('lease_adoption_is_refused_when_owner_identity_cannot_be_confirmed', async () => {
    // Processo dono vivo, mas start_time indisponível: nunca autoriza adoção na dúvida.
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    mkdirSync(leaseDir, { recursive: true })
    const oldOwner: LeaseOwner = {
      pid: 44444,
      start_time: 'S',
      host: 'HOST_UNKNOWN',
      engine_version: '0.1.0',
      acquired_at: '2026-09-17T08:00:00Z',
    }
    writeFileSync(path.join(leaseDir, 'owner.json'), JSON.stringify(oldOwner))
    const heartbeatPath = path.join(leaseDir, 'heartbeat')
    const past = new Date(Date.now() - 60000)
    writeFileSync(heartbeatPath, past.toISOString())
    utimesSync(heartbeatPath, past, past)

    let err: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        isAlive: () => true,
        getStartTime: async () => null,
      })
    } catch (e) {
      err = e as LeaseAwaitingOperatorError
    }
    expect(err).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(err).toBeInstanceOf(AdeError)
    expect(err?.code).toBe('awaiting_operator')
    expect(err?.exitCode).toBe(3)
    expect((err?.details?.owner as Record<string, unknown>)?.pid).toBe(44444)
  })

  test('lease_adoption_failure_preserves_previous_owner_state', async () => {
    // Falha durante a adoção não pode apagar o estado do dono anterior.
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    mkdirSync(leaseDir, { recursive: true })
    const oldOwner: LeaseOwner = {
      pid: 33333,
      start_time: 'S_OLD',
      host: 'HOST_OLD2',
      engine_version: '0.1.0',
      acquired_at: '2026-09-17T08:00:00Z',
    }
    const ownerPath = path.join(leaseDir, 'owner.json')
    writeFileSync(ownerPath, JSON.stringify(oldOwner))
    const heartbeatPath = path.join(leaseDir, 'heartbeat')
    const past = new Date(Date.now() - 60000)
    writeFileSync(heartbeatPath, past.toISOString())
    utimesSync(heartbeatPath, past, past)

    let thrown: unknown = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        isAlive: () => false,
        getStartTime: async () => {
          throw new Error('falha simulada')
        },
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)

    expect(existsSync(leaseDir)).toBe(true)
    expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toEqual(oldOwner)
  })

  test('lease_adoption_of_expired_lease_is_atomic_under_concurrency', async () => {
    // Duas aquisições concorrentes do mesmo lease expirado: exatamente uma adota.
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    mkdirSync(leaseDir, { recursive: true })
    writeFileSync(
      path.join(leaseDir, 'owner.json'),
      JSON.stringify({
        pid: 22222,
        start_time: 'S_RACE',
        host: 'HOST_RACE',
        engine_version: '0.1.0',
        acquired_at: '2026-09-17T08:00:00Z',
      }),
    )
    const heartbeatPath = path.join(leaseDir, 'heartbeat')
    const past = new Date(Date.now() - 60000)
    writeFileSync(heartbeatPath, past.toISOString())
    utimesSync(heartbeatPath, past, past)

    const results = await Promise.allSettled([
      acquire({
        missionDir,
        ttlMs: 15000,
        heartbeatMs: 50,
        getStartTime: async () => 'T_A',
        isAlive: () => false,
      }),
      acquire({
        missionDir,
        ttlMs: 15000,
        heartbeatMs: 50,
        getStartTime: async () => 'T_B',
        isAlive: () => false,
      }),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Lease> => r.status === 'fulfilled',
    )
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0].reason).toBeInstanceOf(CoordinatorConflictError)

    const winner = fulfilled[0].value
    try {
      expect(winner.adopted).toBe(true)
    } finally {
      await winner.release()
    }
  })

  test('lease_directory_is_not_created_before_start_time_resolves', async () => {
    // A pasta lease/ não pode existir enquanto a identidade do dono está sendo lida:
    // um lease sem owner.json nem heartbeat parece órfão para quem chega depois.
    const missionDir = createMissionDir()
    const leaseDir = path.join(missionDir, 'lease')
    let existedDuringResolve: boolean | null = null

    const lease = await acquire({
      missionDir,
      heartbeatMs: 50,
      ttlMs: 1000,
      getStartTime: async () => {
        existedDuringResolve = existsSync(leaseDir)
        return 'T0'
      },
    })

    try {
      expect(existedDuringResolve).toBe(false)
      expect(existsSync(path.join(leaseDir, 'owner.json'))).toBe(true)
    } finally {
      await lease.release()
    }
  })

  test('slow_start_time_does_not_allow_two_concurrent_acquisitions', async () => {
    // Rodada de revisão: `getStartTime` mais lento que o TTL não pode permitir que
    // duas aquisições resolvam com sucesso sobre o mesmo missionDir.
    const missionDir = createMissionDir()

    const slow = acquire({
      missionDir,
      ttlMs: 200,
      heartbeatMs: 20,
      isAlive: () => false,
      getStartTime: async () => {
        await new Promise((r) => setTimeout(r, 1200))
        return 'T_SLOW'
      },
    })

    // O segundo adquirente entra depois de o TTL já ter vencido para qualquer
    // pasta que o primeiro tivesse criado cedo demais.
    await new Promise((r) => setTimeout(r, 400))

    const fast = acquire({
      missionDir,
      ttlMs: 200,
      heartbeatMs: 20,
      isAlive: () => false,
      getStartTime: async () => 'T_FAST',
    })

    const results = await Promise.allSettled([slow, fast])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Lease> => r.status === 'fulfilled',
    )

    try {
      expect(fulfilled.length).toBe(1)
      expect(fulfilled[0].value.owner.start_time).toBe('T_FAST')
      const ownerContent = JSON.parse(
        readFileSync(path.join(missionDir, 'lease', 'owner.json'), 'utf8'),
      ) as LeaseOwner
      expect(ownerContent.start_time).toBe('T_FAST')
    } finally {
      for (const r of fulfilled) {
        await r.value.release()
      }
    }
  })
})
