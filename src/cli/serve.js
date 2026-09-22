// @ts-check
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { exitCodeOf } from './exit-codes.js'
import { startServer } from '../panel/server.js'

/**
 * Ponto de entrada do comando `ade serve`.
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

  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: false,
      options: {
        repo: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
      },
    })

    const repoDir = path.resolve(values.repo || env.ADE_REPO_DIR || process.cwd())
    const port = values.port ? parseInt(values.port, 10) : 4173
    const openBrowser = !values['no-open']

    const serverHandle = await startServer({
      repoDir,
      port,
      openBrowser,
      deps: {
        ...deps,
        stdout,
        stderr,
      },
    })

    // Tratamento de interrupção normal ou sinal
    const cleanup = async () => {
      await serverHandle.close()
    }

    process.once('SIGINT', cleanup)
    process.once('SIGTERM', cleanup)

    // Se no-open foi passado em modo teste/não-interativo, podemos manter aberto ou retornar
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`ade serve: ${msg}\n`)
    return exitCodeOf(err)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
