// @ts-check
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { exitCodeOf } from './exit-codes.js'
import { checkNativeSqlite, rebuildProjection } from '../panel/sqlite-index.js'

/**
 * Ponto de entrada do comando `ade index`.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stdout?: { write: (s: string) => void } | ((s: string) => void),
 *   stderr?: { write: (s: string) => void } | ((s: string) => void),
 *   deps?: {
 *     checkNativeSqlite?: () => any,
 *     rebuildProjection?: typeof rebuildProjection,
 *   },
 *   checkNativeSqlite?: () => any,
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

  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: false,
      options: {
        rebuild: { type: 'boolean' },
        repo: { type: 'string' },
      },
    })

    if (!values.rebuild) {
      stderr.write('uso: ade index --rebuild [--repo <pasta>]\n')
      return 4
    }

    const repoDir = path.resolve(values.repo || env.ADE_REPO_DIR || process.cwd())

    // 1. Verificação antecipada da capacidade nativa antes de modificar qualquer índice
    const probeFn = deps.deps?.checkNativeSqlite ?? deps.checkNativeSqlite ?? checkNativeSqlite
    probeFn()

    // 2. Reconstrução atômica da projeção
    const rebuildFn = deps.deps?.rebuildProjection ?? rebuildProjection
    const result = await rebuildFn({ repoDir })

    stdout.write(`Índice reconstruído: ${result.missions} missões, ${result.events} eventos (digest ${result.digest})\n`)
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`ade index: ${msg}\n`)
    return exitCodeOf(err)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
