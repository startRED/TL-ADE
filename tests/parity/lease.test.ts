import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError, CoordinatorConflictError } from '../../src/journal/errors.ts'
import { acquireLease } from '../../src/lease/lease.ts'
import { makeRepo, removeRepo } from '../helpers/git-repo.ts'

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
let repoDirs: string[] = []

afterEach(() => {
  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  repoDirs = []
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

describe('lease parity', () => {
  // AC1, AC2, AC3 e exemplos de acquireLease exclusivo
  test('lease_is_exclusive', async () => {
    // AC1: Dado um missionDir vazio, quando acquireLease resolve:
    const missionDir = createMissionDir()
    const fixedDate = new Date('2026-09-17T12:00:00.123Z')

    const repo = makeRepo()
    repoDirs.push(repo.dir)
    writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])
    const treeBefore = repo.git(['rev-parse', 'HEAD^{tree}']).trim()

    // No aceite 1, NÃO passar engineVersion: o default '0.1.0' deve aparecer no arquivo
    const lease = await acquire({
      missionDir,
      heartbeatMs: 50,
      ttlMs: 1000,
      getStartTime: async () => 'T0',
      now: () => fixedDate,
    })

    const leaseDir = path.join(missionDir, 'lease')
    const ownerPath = path.join(leaseDir, 'owner.json')
    const heartbeatPath = path.join(leaseDir, 'heartbeat')

    try {
      expect(existsSync(ownerPath)).toBe(true)
      const ownerContent = JSON.parse(readFileSync(ownerPath, 'utf8')) as LeaseOwner
      const expectedOwner: LeaseOwner = {
        pid: process.pid,
        start_time: 'T0',
        host: os.hostname(),
        engine_version: '0.1.0',
        acquired_at: '2026-09-17T12:00:00Z',
      }
      expect(ownerContent).toEqual(expectedOwner)

      expect(existsSync(heartbeatPath)).toBe(true)
      const heartbeatContent = readFileSync(heartbeatPath, 'utf8')
      expect(heartbeatContent.length).toBeGreaterThan(0)

      expect(lease.adopted).toBe(false)
      expect(lease.previousOwner).toBeNull()
      expect(lease.dir).toBe(leaseDir)
      expect(lease.owner).toEqual(expectedOwner)

      // AC2: Dado esse lease vivo, quando um segundo acquireLease no mesmo missionDir roda:
      let conflictErr: CoordinatorConflictError | null = null
      try {
        await acquire({
          missionDir,
          heartbeatMs: 50,
          ttlMs: 1000,
          getStartTime: async () => 'T0',
        })
      } catch (err) {
        conflictErr = err as CoordinatorConflictError
      }
      expect(conflictErr).toBeInstanceOf(CoordinatorConflictError)
      expect(conflictErr).toBeInstanceOf(AdeError)
      expect(conflictErr?.code).toBe('coordinator_conflict')
      expect(conflictErr?.exitCode).toBe(5)
      expect(conflictErr?.details?.owner).toBeDefined()
      const conflictOwner = conflictErr?.details?.owner as Record<string, unknown>
      expect(conflictOwner?.pid).toBe(process.pid)

      const treeAfter = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
      expect(treeAfter).toBe(treeBefore)

      // O owner.json do primeiro fica intacto
      expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toEqual(expectedOwner)

      // AC3: Dado o lease liberado por release() (chamado duas vezes sem erro):
      await lease.release()
      await lease.release()

      // A pasta lease/ não existia entre um e outro
      expect(existsSync(leaseDir)).toBe(false)

      // Quando um novo acquireLease roda, então resolve
      const newLease = await acquire({
        missionDir,
        heartbeatMs: 50,
        ttlMs: 1000,
        getStartTime: async () => 'T0',
      })
      try {
        expect(newLease.adopted).toBe(false)
        expect(existsSync(ownerPath)).toBe(true)
      } finally {
        await newLease.release()
      }
    } finally {
      await lease.release()
    }

    // Exemplo: acquireLease com engineVersion customizado ('9.9.9')
    const missionDirCustom = createMissionDir()
    const customLease = await acquire({
      missionDir: missionDirCustom,
      engineVersion: '9.9.9',
      getStartTime: async () => 'T0',
    })
    try {
      const customOwnerPath = path.join(missionDirCustom, 'lease', 'owner.json')
      const customOwner = JSON.parse(readFileSync(customOwnerPath, 'utf8')) as LeaseOwner
      expect(customOwner.engine_version).toBe('9.9.9')
    } finally {
      await customLease.release()
    }

    // Exemplo: pasta lease/ existente sem owner.json -> rejeita CoordinatorConflictError com details.owner === null e mensagem esperada
    const missionDirNoOwner = createMissionDir()
    mkdirSync(path.join(missionDirNoOwner, 'lease'))
    let noOwnerErr: CoordinatorConflictError | null = null
    try {
      await acquire({
        missionDir: missionDirNoOwner,
        getStartTime: async () => 'T0',
      })
    } catch (err) {
      noOwnerErr = err as CoordinatorConflictError
    }
    expect(noOwnerErr).toBeInstanceOf(CoordinatorConflictError)
    expect(noOwnerErr).toBeInstanceOf(AdeError)
    expect(noOwnerErr?.code).toBe('coordinator_conflict')
    expect(noOwnerErr?.exitCode).toBe(5)
    expect(noOwnerErr?.details?.owner).toBeNull()
    expect(noOwnerErr?.message).toBe(
      'coordinator_conflict: lease em uso por pid desconhecido',
    )

    // Exemplo: acquireLease({missionDir, ttlMs: 0}) -> rejeita TypeError('opções de lease inválidas')
    const missionDirInvalid = createMissionDir()
    let typeErr: TypeError | null = null
    try {
      await acquire({
        missionDir: missionDirInvalid,
        ttlMs: 0,
        getStartTime: async () => 'T0',
      })
    } catch (err) {
      typeErr = err as TypeError
    }
    expect(typeErr).toBeInstanceOf(TypeError)
    expect(typeErr?.message).toBe('opções de lease inválidas')
  })
})
