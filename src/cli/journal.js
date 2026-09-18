// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readJournal } from '../journal/journal.js'

/**
 * Ponto de entrada do comando `ade journal`.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stdout?: { write: (s: string) => void } | ((s: string) => void),
 *   stderr?: { write: (s: string) => void } | ((s: string) => void),
 *   [key: string]: any,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
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
      unit: { type: 'string' },
    },
  })

  const missionDir = values.mission ?? env.ADE_MISSION_DIR
  if (!missionDir) {
    stderr.write('uso: ade journal --mission <pasta> [--unit <id>]\n')
    return 4
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) {
    stderr.write(`journal ausente: ${journalPath}\n`)
    return 4
  }

  const { events } = readJournal(journalPath)
  const unitOf = (/** @type {any} */ ev) => ev.data?.unit ?? ev.unit ?? '-'

  let list = events
  if (values.unit) {
    list = list.filter((ev) => unitOf(ev) === values.unit)
  }

  if (list.length === 0) {
    stdout.write('nenhum evento\n')
    return 0
  }

  for (const ev of list) {
    const stepPart = typeof ev.step_id === 'string' ? ` ${ev.step_id}` : ''
    stdout.write(`${ev.seq} ${ev.kind} ${unitOf(ev)}${stepPart}\n`)
  }

  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
