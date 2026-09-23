import fs from 'node:fs'
import path from 'node:path'
import { digest16 } from '../journal/canonical.ts'

/**
 * Grava ou reproduz o resultado de um produtor externo com referência raw_ref.
 */
export async function recordOrReplay(spec: {
recordPath?: string
input_digest?: string
rawRef?: string
missionDir?: string
}, producer: () => Promise<any>): Promise<{ result: any; raw_ref: string; replayed: boolean }> {
  const digest = spec.input_digest || digest16(spec)
  const baseDir = spec.missionDir || process.cwd()
  const filePath = spec.recordPath || path.join(baseDir, '.ade', 'recordings', `${digest}.json`)
  const rawRef = spec.rawRef || `art:recordings/${digest}`

  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return { result: data, raw_ref: rawRef, replayed: true }
  }

  const result = await producer()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8')

  return { result, raw_ref: rawRef, replayed: false }
}
