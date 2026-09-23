import { parseArgs } from 'node:util'
import { syncDocProjections } from '../docs/projection.ts'
import { exitCodeOf } from './exit-codes.ts'

/**
 * CLI para sincronização e projeção de documentos: `ade docs sync [--repo <dir>]`
 */
export async function main(argv: string[], deps: {
    stdout?: { write: (s: string) => void }
    stderr?: { write: (s: string) => void }
    env?: Record<string, string | undefined>
} = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  const sub = argv[0]
  if (sub !== 'sync' && sub !== 'check' && sub !== undefined && !sub.startsWith('-')) {
    stderr.write(`uso: ade docs <sync|check> [--repo <pasta>]\n`)
    return 4
  }

  const subArgs = sub && !sub.startsWith('-') ? argv.slice(1) : argv

  const parsed = parseArgs({
    args: subArgs,
    allowPositionals: false,
    strict: false,
    options: {
      repo: { type: 'string' },
      mission: { type: 'string' },
    },
  })

  const repoDir = parsed.values.repo ? String(parsed.values.repo) : process.cwd()
  const missionDir = parsed.values.mission ? String(parsed.values.mission) : undefined

  try {
    const created = syncDocProjections({ repoDir, missionDir })
    stdout.write(`Documentação projetada com sucesso em docs/generated/:\n`)
    for (const p of created) {
      stdout.write(`- ${p}\n`)
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`ade docs falhou: ${msg}\n`)
    return exitCodeOf(err)
  }
}
