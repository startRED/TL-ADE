import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function makeTmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
