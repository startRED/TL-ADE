import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
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

interface PlantOrphanOptions {
  ageMs?: number
  owner?: Record<string, unknown> | null
  skipOwner?: boolean
}

function plantOrphanLease(
  missionDir: string,
  options?: PlantOrphanOptions,
): { leaseDir: string; defaultOwner: LeaseOwner } {
  const leaseDir = path.join(missionDir, 'lease')
  mkdirSync(leaseDir, { recursive: true })

  const defaultOwner: LeaseOwner = {
    pid: 424242,
    start_time: 'OLD',
    host: 'h',
    engine_version: '0.1.0',
    acquired_at: '2026-09-17T11:00:00Z',
  }

  if (!options?.skipOwner) {
    const ownerToSave = options?.owner !== undefined ? options.owner : defaultOwner
    if (ownerToSave !== null) {
      writeFileSync(path.join(leaseDir, 'owner.json'), JSON.stringify(ownerToSave))
    }
  }

  const heartbeatPath = path.join(leaseDir, 'heartbeat')
  const now = new Date()
  writeFileSync(heartbeatPath, now.toISOString())

  const ageMs = options?.ageMs ?? 0
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    utimesSync(heartbeatPath, past, past)
  }

  return { leaseDir, defaultOwner }
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
    // Caso 1 (Aceite 1): TTL não vencido -> exit 5 e owner.json intacto
    const missionDirFresh = createMissionDir()
    const { defaultOwner: expectedFreshOwner } = plantOrphanLease(missionDirFresh, { ageMs: 0 })
    const freshOwnerPath = path.join(missionDirFresh, 'lease', 'owner.json')

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
    expect(JSON.parse(readFileSync(freshOwnerPath, 'utf8'))).toEqual(expectedFreshOwner)

    // Caso 2 (Aceite 2): Dono morto após TTL -> adota, previousOwner.pid === 424242,
    // owner.json atualizado com pid do processo atual, sem pastas lease.stale-* restantes
    const missionDirExpired = createMissionDir()
    const { defaultOwner: expectedOldOwner } = plantOrphanLease(missionDirExpired, { ageMs: 60000 })
    const expiredOwnerPath = path.join(missionDirExpired, 'lease', 'owner.json')

    const adoptedLease = await acquire({
      missionDir: missionDirExpired,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async () => 'T_NEW_OWNER',
      isAlive: () => false,
    })

    try {
      expect(adoptedLease.adopted).toBe(true)
      expect(adoptedLease.previousOwner).toEqual(expectedOldOwner)
      expect(adoptedLease.owner.pid).toBe(process.pid)
      expect(adoptedLease.owner.start_time).toBe('T_NEW_OWNER')
      const updatedOwner = JSON.parse(readFileSync(expiredOwnerPath, 'utf8')) as LeaseOwner
      expect(updatedOwner.pid).toBe(process.pid)

      const staleDirs = readdirSync(missionDirExpired).filter((f) => f.startsWith('lease.stale-'))
      expect(staleDirs).toEqual([])
    } finally {
      await adoptedLease.release()
    }

    // Caso 3 (Aceite 3): PID reciclado com getStartTime -> 'NEW' e com getStartTime -> null -> adota
    // 3a: getStartTime devolve 'NEW' para 424242
    const missionDirRecycledNew = createMissionDir()
    plantOrphanLease(missionDirRecycledNew, { ageMs: 60000 })

    const adoptedRecycledNew = await acquire({
      missionDir: missionDirRecycledNew,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async (pid) => (pid === 424242 ? 'NEW' : 'SELF'),
      isAlive: (pid) => pid === 424242,
    })

    try {
      expect(adoptedRecycledNew.adopted).toBe(true)
      expect(adoptedRecycledNew.previousOwner?.pid).toBe(424242)
      expect(adoptedRecycledNew.previousOwner?.start_time).toBe('OLD')
      expect(adoptedRecycledNew.owner.start_time).toBe('SELF')
    } finally {
      await adoptedRecycledNew.release()
    }

    // 3b: getStartTime devolve null para 424242
    const missionDirRecycledNull = createMissionDir()
    plantOrphanLease(missionDirRecycledNull, { ageMs: 60000 })

    const adoptedRecycledNull = await acquire({
      missionDir: missionDirRecycledNull,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async (pid) => (pid === 424242 ? null : 'SELF'),
      isAlive: (pid) => pid === 424242,
    })

    try {
      expect(adoptedRecycledNull.adopted).toBe(true)
      expect(adoptedRecycledNull.previousOwner?.pid).toBe(424242)
      expect(adoptedRecycledNull.previousOwner?.start_time).toBe('OLD')
      expect(adoptedRecycledNull.owner.start_time).toBe('SELF')
    } finally {
      await adoptedRecycledNull.release()
    }
  })

  test('expired_lease_with_live_same_process_waits_for_operator', async () => {
    // Aceite 4: Dono vivo com o mesmo start_time após TTL -> awaiting_operator (exit 3)
    const missionDir = createMissionDir()
    plantOrphanLease(missionDir, { ageMs: 60000 })
    const ownerPath = path.join(missionDir, 'lease', 'owner.json')

    let operatorErr: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        getStartTime: async (pid) => (pid === 424242 ? 'OLD' : 'SELF'),
        isAlive: (pid) => pid === 424242,
      })
    } catch (err) {
      operatorErr = err as LeaseAwaitingOperatorError
    }

    expect(operatorErr).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(operatorErr).toBeInstanceOf(AdeError)
    expect(operatorErr?.code).toBe('awaiting_operator')
    expect(operatorErr?.exitCode).toBe(3)
    expect(operatorErr?.message).toBe('awaiting_operator: dono vivo com lease expirado')
    expect((operatorErr?.details?.owner as Record<string, unknown>)?.pid).toBe(424242)

    const currentOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as LeaseOwner
    expect(currentOwner.pid).toBe(424242)
    expect(currentOwner.start_time).toBe('OLD')
  })

  test('expired_lease_with_invalid_owner_waits_for_operator', async () => {
    // Caso 1: pasta lease/ velha só com heartbeat envelhecido (sem owner.json)
    // -> exit 3, mensagem 'awaiting_operator: owner inválido', details.owner === null e lease/ intacta, sem lease.stale-*
    const missionDirNoOwner = createMissionDir()
    plantOrphanLease(missionDirNoOwner, { ageMs: 60000, skipOwner: true })
    const leaseDirNoOwner = path.join(missionDirNoOwner, 'lease')

    let errNoOwner: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir: missionDirNoOwner,
        ttlMs: 15000,
        isAlive: () => false,
        getStartTime: async () => 'SELF',
      })
    } catch (err) {
      errNoOwner = err as LeaseAwaitingOperatorError
    }

    expect(errNoOwner).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(errNoOwner).toBeInstanceOf(AdeError)
    expect(errNoOwner?.code).toBe('awaiting_operator')
    expect(errNoOwner?.exitCode).toBe(3)
    expect(errNoOwner?.message).toBe('awaiting_operator: owner inválido')
    expect(errNoOwner?.details?.owner).toBeNull()
    expect(existsSync(leaseDirNoOwner)).toBe(true)
    expect(existsSync(path.join(leaseDirNoOwner, 'heartbeat'))).toBe(true)

    const staleDirsNoOwner = readdirSync(missionDirNoOwner).filter((f) =>
      f.startsWith('lease.stale-'),
    )
    expect(staleDirsNoOwner).toEqual([])

    // Caso 2: owner.json válido como JSON mas { pid: 'x' }
    // -> exit 3, mensagem 'awaiting_operator: owner inválido', details.owner === null e lease/ intacta, sem lease.stale-*
    const missionDirInvalidOwner = createMissionDir()
    plantOrphanLease(missionDirInvalidOwner, {
      ageMs: 60000,
      owner: { pid: 'x', start_time: 'OLD' },
    })
    const leaseDirInvalidOwner = path.join(missionDirInvalidOwner, 'lease')

    let errInvalidOwner: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir: missionDirInvalidOwner,
        ttlMs: 15000,
        isAlive: () => false,
        getStartTime: async () => 'SELF',
      })
    } catch (err) {
      errInvalidOwner = err as LeaseAwaitingOperatorError
    }

    expect(errInvalidOwner).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(errInvalidOwner).toBeInstanceOf(AdeError)
    expect(errInvalidOwner?.code).toBe('awaiting_operator')
    expect(errInvalidOwner?.exitCode).toBe(3)
    expect(errInvalidOwner?.message).toBe('awaiting_operator: owner inválido')
    expect(errInvalidOwner?.details?.owner).toBeNull()
    expect(existsSync(leaseDirInvalidOwner)).toBe(true)
    expect(existsSync(path.join(leaseDirInvalidOwner, 'owner.json'))).toBe(true)

    const staleDirsInvalidOwner = readdirSync(missionDirInvalidOwner).filter((f) =>
      f.startsWith('lease.stale-'),
    )
    expect(staleDirsInvalidOwner).toEqual([])
  })

  test('unknown_start_time_never_steals_the_lease', async () => {
    // getStartTime rejeita para 424242 -> exit 3, mensagem 'awaiting_operator: start_time do pid 424242 indeterminado'
    const missionDir = createMissionDir()
    plantOrphanLease(missionDir, { ageMs: 60000 })

    let err: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        isAlive: (pid) => pid === 424242,
        getStartTime: async (pid) => {
          if (pid === 424242) {
            throw new Error('falha ao consultar start_time')
          }
          return 'SELF'
        },
      })
    } catch (e) {
      err = e as LeaseAwaitingOperatorError
    }

    expect(err).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(err).toBeInstanceOf(AdeError)
    expect(err?.code).toBe('awaiting_operator')
    expect(err?.exitCode).toBe(3)
    expect(err?.message).toBe('awaiting_operator: start_time do pid 424242 indeterminado')
    expect(err?.details?.reason).toBe('start_time do pid 424242 indeterminado')
    expect((err?.details?.owner as Record<string, unknown>)?.pid).toBe(424242)
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

  test('injected_now_does_not_alter_lease_ttl_expiration', async () => {
    // Prova de que now injetado não altera a expiração por TTL:
    // 1. Heartbeat recente não expira mesmo se now() injetado estiver adiantado no futuro
    const missionDirFresh = createMissionDir()
    plantOrphanLease(missionDirFresh, { ageMs: 0 })

    let conflictErr: CoordinatorConflictError | null = null
    try {
      await acquire({
        missionDir: missionDirFresh,
        ttlMs: 15000,
        isAlive: () => false,
        now: () => new Date(Date.now() + 100000),
      })
    } catch (err) {
      conflictErr = err as CoordinatorConflictError
    }
    expect(conflictErr).toBeInstanceOf(CoordinatorConflictError)
    expect(conflictErr?.code).toBe('coordinator_conflict')
    expect(conflictErr?.exitCode).toBe(5)

    // 2. Heartbeat expirado (60 s atrás) é adotado mesmo se now() injetado estiver atrasado no passado
    const missionDirExpired = createMissionDir()
    const { defaultOwner: expectedOldOwner } = plantOrphanLease(missionDirExpired, { ageMs: 60000 })

    const adoptedLease = await acquire({
      missionDir: missionDirExpired,
      ttlMs: 15000,
      heartbeatMs: 50,
      getStartTime: async () => 'T_INJECTED_TEST',
      isAlive: () => false,
      now: () => new Date(Date.now() - 60000),
    })

    try {
      expect(adoptedLease.adopted).toBe(true)
      expect(adoptedLease.previousOwner).toEqual(expectedOldOwner)
    } finally {
      await adoptedLease.release()
    }
  })

  test('stale_dir_is_cleaned_up_when_mkdir_loses_race_after_rename', async () => {
    // Rodada de revisão: se outro processo recriar lease/ entre o renameSync do
    // lease expirado e o mkdirSync do adotante, não pode sobrar lease.stale-*.
    const missionDir = createMissionDir()
    plantOrphanLease(missionDir, { ageMs: 60000 })
    const leaseDir = path.join(missionDir, 'lease')

    const realRenameSync = fs.renameSync.bind(fs)
    const renameSyncSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((oldPath, newPath) => {
        realRenameSync(oldPath, newPath)
        // Simula outro processo vencendo a corrida e recriando lease/ antes
        // do mkdirSync interno do adotante.
        mkdirSync(leaseDir)
      })

    let conflictErr: CoordinatorConflictError | null = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        isAlive: () => false,
      })
    } catch (err) {
      conflictErr = err as CoordinatorConflictError
    } finally {
      renameSyncSpy.mockRestore()
    }

    expect(conflictErr).toBeInstanceOf(CoordinatorConflictError)
    expect(conflictErr).toBeInstanceOf(AdeError)
    expect(conflictErr?.code).toBe('coordinator_conflict')
    expect(conflictErr?.exitCode).toBe(5)

    // O lease/ do "vencedor" da corrida permanece intacto.
    expect(existsSync(leaseDir)).toBe(true)
    // Nenhuma pasta lease.stale-* sobra: a falha de mkdir limpa o staleDir desta tentativa.
    const staleDirs = readdirSync(missionDir).filter((f) => f.startsWith('lease.stale-'))
    expect(staleDirs).toEqual([])
  })

  test('is_alive_failure_never_steals_the_lease', async () => {
    // Rodada de revisão: se `isAlive` lançar ao avaliar um lease expirado, a falha
    // vira rejeição tipada de lease (exit 3) e nada é adotado nem removido.
    const missionDir = createMissionDir()
    const { defaultOwner } = plantOrphanLease(missionDir, { ageMs: 60000 })
    const leaseDir = path.join(missionDir, 'lease')
    const ownerPath = path.join(leaseDir, 'owner.json')

    let err: LeaseAwaitingOperatorError | null = null
    try {
      await acquire({
        missionDir,
        ttlMs: 15000,
        isAlive: () => {
          throw new Error('falha ao consultar o processo')
        },
        getStartTime: async () => 'SELF',
      })
    } catch (e) {
      err = e as LeaseAwaitingOperatorError
    }

    expect(err).toBeInstanceOf(LeaseAwaitingOperatorError)
    expect(err).toBeInstanceOf(AdeError)
    expect(err?.code).toBe('awaiting_operator')
    expect(err?.exitCode).toBe(3)
    expect(err?.message).toBe('awaiting_operator: estado do pid 424242 indeterminado')
    expect((err?.details?.owner as Record<string, unknown>)?.pid).toBe(424242)

    // O lease anterior permanece intacto e nenhuma pasta lease.stale-* é criada.
    expect(existsSync(leaseDir)).toBe(true)
    expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toEqual(defaultOwner)
    const staleDirs = readdirSync(missionDir).filter((f) => f.startsWith('lease.stale-'))
    expect(staleDirs).toEqual([])
  })
})
