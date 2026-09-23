// @ts-check
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalize } from '../journal/canonical.ts'
import { approveMission } from '../mission/plan-lifecycle.ts'

/**
 * Ponto de entrada do comando `ade approve`.
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
      mission: { type: 'string', short: 'm' },
      digest: { type: 'string', short: 'd' },
      repo: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const missionId = values.mission || positionals[0]
  const digest = values.digest || positionals[1]
  const repoDir = values.repo ?? env.ADE_REPO_DIR ?? process.cwd()

  if (!missionId || !digest) {
    stderr.write('uso: ade approve --mission <id> --digest <hex> [--repo <pasta>] [--json]\n')
    return 4
  }

  try {
    const result = await approveMission(
      {
        missionId: String(missionId),
        expectedDigest: String(digest),
        repoDir: String(repoDir),
      },
      deps,
    )

    if (!result.approved) {
      stderr.write(`aprovação recusada: ${result.reason || 'digest incompatível ou plano alterado'}\n`)
      return 4
    }

    if (values.json) {
      stdout.write(canonicalize(result) + '\n')
    } else {
      stdout.write(`missão aprovada: ${missionId} (digest ${result.digest})\n`)
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`erro na aprovação: ${msg}\n`)
    return 4
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
