// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readJournal } from '../journal/journal.js'
import { projectUnits } from './project.js'

/**
 * Renderiza o relatório da missão em markdown.
 *
 * @param {string} mission
 * @param {Array<{ unit: string, status: string, reason?: string | null, commit?: string | null }>} units
 * @returns {string}
 */
export function renderReport(mission, units) {
  let report = `# Relatório da missão ${mission}\n\n`
  if (units.length === 0) {
    report += 'Nenhuma unidade registrada.\n'
    return report
  }

  report += '| unidade | estado | motivo | commit |\n| --- | --- | --- | --- |\n'
  for (const u of units) {
    const reason = u.reason ?? '-'
    const commit = u.commit ? u.commit.slice(0, 12) : '-'
    report += `| ${u.unit} | ${u.status} | ${reason} | ${commit} |\n`
  }

  report += '\n## Próximos passos\n\n'
  for (const u of units) {
    if (u.status === 'committed') {
      report += `- ${u.unit}: git merge --ff-only ade/${mission}/${u.unit}\n`
    } else if (u.status === 'awaiting_operator') {
      const reasonPart = u.reason ?? 'sem motivo'
      report += `- ${u.unit}: resolver awaiting_operator (${reasonPart})\n`
    } else {
      report += `- ${u.unit}: em andamento\n`
    }
  }

  return report
}

/**
 * Ponto de entrada do comando `ade report`.
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
      out: { type: 'string' },
    },
  })

  const missionDir = values.mission ?? env.ADE_MISSION_DIR
  if (!missionDir) {
    stderr.write('uso: ade report --mission <pasta> [--out <arquivo>]\n')
    return 4
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) {
    stderr.write(`journal ausente: ${journalPath}\n`)
    return 4
  }

  const { events } = readJournal(journalPath)
  const mission = path.basename(missionDir)
  const outPath = path.resolve(values.out ?? path.join(missionDir, 'report.md'))
  fs.writeFileSync(outPath, renderReport(mission, projectUnits(events)), 'utf8')
  stdout.write(`relatório: ${outPath}\n`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
