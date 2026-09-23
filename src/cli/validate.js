// @ts-check
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalize } from '../journal/canonical.ts'
import { validateMissionPlan } from '../mission/plan-lifecycle.js'

/**
 * Ponto de entrada do comando `ade validate`.
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
  const stdout =
    typeof deps.stdout === 'function'
      ? { write: deps.stdout }
      : (deps.stdout ?? process.stdout)
  const stderr =
    typeof deps.stderr === 'function'
      ? { write: deps.stderr }
      : (deps.stderr ?? process.stderr)

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      plan: { type: 'string', short: 'p' },
      json: { type: 'boolean' },
    },
  })

  const planPath = values.plan || positionals[0]
  if (!planPath) {
    stderr.write('uso: ade validate [--plan <arquivo>] [--json]\n')
    return 4
  }

  const result = validateMissionPlan(String(planPath))

  if (!result.valid) {
    if (values.json) {
      stdout.write(canonicalize(result) + '\n')
    } else {
      stderr.write(`plano invalido: ${planPath}\n`)
      for (const err of result.errors) {
        stderr.write(`  ${err.path}: ${err.message}\n`)
      }
    }
    return 4
  }

  if (values.json) {
    stdout.write(canonicalize(result) + '\n')
  } else {
    stdout.write(`plano valido: ${planPath} (digest ${result.digest})\n`)
  }
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
