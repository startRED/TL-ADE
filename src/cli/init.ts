import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { exitCodeOf } from './exit-codes.ts'
import { registerProject } from '../panel/projects.ts'
import { generateLauncher } from '../panel/launcher.ts'

/**
 * Ponto de entrada do comando `ade init`.
 */
export async function main(argv: string[], deps: {
    env?: Record<string, string | undefined>
    stdout?: { write: (s: string) => void } | ((s: string) => void)
    stderr?: { write: (s: string) => void } | ((s: string) => void)
    homeDir?: string;
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
      },
    })

    const repoDir = path.resolve((values.repo as string | undefined) || env.ADE_REPO_DIR || process.cwd())

    // 1. Assegura diretório de metadados sem apagar arquivos existentes
    const adeDir = path.join(repoDir, '.ade')
    fs.mkdirSync(adeDir, { recursive: true })

    // 2. Registra o projeto no catálogo de projetos do operador
    const project = registerProject({ repoDir, homeDir: deps.homeDir })

    // 3. Gera o lançador ade.bat de dois cliques
    const launcherPath = generateLauncher({ repoDir })

    stdout.write(`Projeto "${project.name}" registrado em ${repoDir}.\nLançador gerado em ${launcherPath}\n`)
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`ade init: ${msg}\n`)
    return exitCodeOf(err)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
