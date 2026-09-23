import fs from 'node:fs'
import path from 'node:path'
import { CoordinatorConflictError } from '../journal/errors.ts'

const ACTIVE_LEASES: Set<string> = new Set()

/**
 * Adquire o lease exclusivo para execução de um servidor de painel no repositório.
 * Se outro processo estiver ativo com o lease, lança CoordinatorConflictError (exit 5).
 */
export function acquireServeLease({ repoDir }: { repoDir: string }): { leasePath: string; release: () => void } {
  const resolvedRepo = path.resolve(repoDir)
  if (ACTIVE_LEASES.has(resolvedRepo)) {
    throw new CoordinatorConflictError({ pid: process.pid })
  }

  const adeDir = path.join(resolvedRepo, '.ade')
  fs.mkdirSync(adeDir, { recursive: true })
  const leasePath = path.join(adeDir, 'serve.lease')

  if (fs.existsSync(leasePath)) {
    try {
      const content = fs.readFileSync(leasePath, 'utf8')
      const data = JSON.parse(content)
      const pid = Number(data.pid)

      if (pid) {
        let isRunning = false
        try {
          process.kill(pid, 0)
          isRunning = true
        } catch {
          isRunning = false
        }

        if (isRunning && (pid !== process.pid || ACTIVE_LEASES.has(resolvedRepo))) {
          throw new CoordinatorConflictError({ pid })
        }
      }
    } catch (err) {
      if (err instanceof CoordinatorConflictError) throw err
      // Lease corrompido ou processo morto: remove para recuperar
      try {
        fs.unlinkSync(leasePath)
      } catch {}
    }
  }

  const leaseRecord = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  }

  const tmpPath = `${leasePath}.tmp.${process.pid}`
  fs.writeFileSync(tmpPath, JSON.stringify(leaseRecord, null, 2), 'utf8')
  fs.renameSync(tmpPath, leasePath)

  ACTIVE_LEASES.add(resolvedRepo)

  return {
    leasePath,
    release: () => {
      ACTIVE_LEASES.delete(resolvedRepo)
      try {
        if (fs.existsSync(leasePath)) {
          const raw = fs.readFileSync(leasePath, 'utf8')
          const current = JSON.parse(raw)
          if (current.pid === process.pid) {
            fs.unlinkSync(leasePath)
          }
        }
      } catch {}
    },
  }
}
