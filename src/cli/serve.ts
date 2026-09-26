import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { exitCodeOf } from './exit-codes.ts'
import { startServer } from '../panel/server.ts'

/**
 * Ponto de entrada do comando `ade serve`.
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

    const repoDir = path.resolve(String(values.repo || env.ADE_REPO_DIR || process.cwd()))
    const port = values.port ? parseInt(String(values.port), 10) : 4173
    const openBrowser = !values['no-open']

    const serverHandle = await startServer({
      repoDir,
      port,
      openBrowser,
      deps: {
        // o painel de verdade relê a cota sozinho; servidores de teste não chamam as CLIs dos planos
        watchQuota: true,
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
