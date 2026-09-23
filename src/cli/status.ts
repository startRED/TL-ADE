import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalize } from '../journal/canonical.ts'
import { openIntents } from '../journal/fold.ts'
import { readJournal } from '../journal/journal.ts'
import { projectUnits } from './project.ts'

/**
 * Ponto de entrada do comando `ade status`.
 */
export async function main(argv: string[], deps: {
    env?: Record<string, string | undefined>
    stdout?: { write: (s: string) => void } | ((s: string) => void)
    stderr?: { write: (s: string) => void } | ((s: string) => void);
    [key: string]: any
} = {}): Promise<number> {
  const env = deps.env ?? process.env
  const stdout =
    typeof deps.stdout === 'function'
      ? { write: deps.stdout }
      : (deps.stdout ?? process.stdout)
  const stderr =
    typeof deps.stderr === 'function'
      ? { write: deps.stderr }
      : (deps.stderr ?? process.stderr)

  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      mission: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const missionDir = values.mission ?? env.ADE_MISSION_DIR
  if (!missionDir) {
    stderr.write('uso: ade status --mission <pasta> [--json]\n')
    return 4
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) {
    stderr.write(`journal ausente: ${journalPath}\n`)
    return 4
  }

  const { events } = readJournal(journalPath)
  const units = projectUnits(events)
  const lastSeq = events.at(-1)?.seq ?? 0
  const mission = path.basename(missionDir)

  if (values.json) {
    const payload = {
      mission,
      last_seq: lastSeq,
      open_intents: openIntents(events).length,
      units,
    }
    stdout.write(canonicalize(payload) + '\n')
  } else {
    stdout.write(`missão ${mission} (seq ${lastSeq})\n`)
    if (units.length === 0) {
      stdout.write('nenhuma unidade\n')
    } else {
      for (const u of units) {
        const reasonPart = u.reason ? ` (${u.reason})` : ''
        const commitPart = u.commit ? ` ${u.commit.slice(0, 12)}` : ''
        stdout.write(`${u.unit} ${u.status}${reasonPart}${commitPart}\n`)
      }
    }
  }

  const hasAwaitingOperator = units.some((u) => u.status === 'awaiting_operator')
  return hasAwaitingOperator ? 3 : 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
