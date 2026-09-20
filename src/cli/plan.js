// @ts-check
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalize } from '../journal/canonical.js'
import { planMission } from '../mission/plan-lifecycle.js'

/**
 * Ponto de entrada do comando `ade plan`.
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

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      request: { type: 'string', short: 'r' },
      repo: { type: 'string' },
      'from-mission': { type: 'string' },
      from: { type: 'string' },
      'non-interactive': { type: 'boolean', short: 'n' },
      json: { type: 'boolean' },
    },
  })

  const request = values.request || positionals.join(' ').trim()
  if (!request) {
    stderr.write('uso: ade plan [--request <pedido>] [--repo <pasta>] [--from <missao>] [--non-interactive] [--json]\n')
    return 4
  }

  const repoDir = values.repo ?? env.ADE_REPO_DIR ?? process.cwd()
  const fromMissionId = values['from-mission'] ?? values.from
  const nonInteractive = Boolean(values['non-interactive'])

  try {
    const result = await planMission(
      {
        request: String(request),
        repoDir: String(repoDir),
        fromMissionId: fromMissionId ? String(fromMissionId) : undefined,
        nonInteractive,
      },
      deps,
    )

    if (values.json) {
      stdout.write(canonicalize(result) + '\n')
    } else {
      stdout.write(`missão criada: ${result.missionId} (digest ${result.digest})\n`)
      stdout.write(`plano gravado em: ${result.planPath}\n`)
      if (result.questions && result.questions.length > 0) {
        stdout.write(`perguntas necessárias (${result.questions.length}):\n`)
        for (const q of result.questions) {
          stdout.write(`- ${q.text || q.question || JSON.stringify(q)}\n`)
        }
      }
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`erro ao planejar: ${msg}\n`)
    return 4
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
