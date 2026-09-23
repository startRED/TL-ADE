import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { main as doctorMain } from './doctor.ts'
import { exitCodeOf } from './exit-codes.ts'
import { runCommand } from './run.ts'
import { main as journalMain } from './journal.ts'
import { main as reportMain } from './report.ts'
import { main as showMain } from './show.ts'
import { main as statusMain } from './status.ts'
import { main as docsMain } from './docs.ts'
import { main as gcMain } from './gc.ts'
import { main as planMain } from './plan.ts'
import { main as validateMain } from './validate.ts'
import { main as approveMain } from './approve.ts'
import { main as catalogMain } from './catalog.ts'
import { main as initMain } from './init.ts'
import { main as serveMain } from './serve.ts'
import { main as indexMain } from './index-command.ts'
import { main as evalMain } from './eval.ts'
import { main as modelsMain } from './models.ts'

const USAGE = 'uso: ade <run|status|journal|report|show|doctor|docs|gc|plan|validate|approve|catalog|init|serve|index|eval|models> ...\n'

/**
 * Ponto de entrada e dispatch de subcomandos da CLI.
 */
export async function main(argv: string[], deps: {
    env?: Record<string, string | undefined>
    stdout?: { write: (s: string) => void } | ((s: string) => void)
    stderr?: { write: (s: string) => void } | ((s: string) => void);
    [key: string]: any
} = {}): Promise<number> {
  const stdout =
    typeof deps.stdout === 'function'
      ? { write: deps.stdout }
      : (deps.stdout ?? process.stdout)
  const stderr =
    typeof deps.stderr === 'function'
      ? { write: deps.stderr }
      : (deps.stderr ?? process.stderr)

  const delegatedDeps = {
    ...deps,
    stdout,
    stderr,
  }

  try {
    const [command, ...commandArgv] = argv

    if (command === '--help' || command === '-h') {
      stdout.write(USAGE)
      return 0
    }

    if (!command || !['run', 'status', 'journal', 'report', 'show', 'doctor', 'docs', 'gc', 'plan', 'validate', 'approve', 'catalog', 'init', 'serve', 'index', 'eval', 'models'].includes(command)) {
      stderr.write(USAGE)
      return 4
    }

    if (command === 'run') {
      const parsed = parseArgs({
        args: commandArgv,
        allowPositionals: false,
        strict: true,
        options: {
          plan: { type: 'string' },
          repo: { type: 'string' },
          'accept-stale-version': { type: 'boolean' },
          unattended: { type: 'boolean' },
        },
      })

      if (!parsed.values.plan) {
        stderr.write('uso: ade run --plan <arquivo> [--repo <pasta>] [--accept-stale-version] [--unattended]\n')
        return 4
      }

      return await runCommand(
        {
          plan: (parsed.values.plan as string),
          repo: (parsed.values.repo as string | undefined),
          acceptStaleVersion: Boolean(parsed.values['accept-stale-version']),
          unattended: Boolean(parsed.values.unattended),
        },
        delegatedDeps,
      )
    }

    if (command === 'status') {
      return await statusMain(commandArgv, delegatedDeps)
    }

    if (command === 'journal') {
      return await journalMain(commandArgv, delegatedDeps)
    }

    if (command === 'report') {
      return await reportMain(commandArgv, delegatedDeps)
    }

    if (command === 'show') {
      return await showMain(commandArgv, delegatedDeps)
    }

    if (command === 'doctor') {
      return await doctorMain(commandArgv, delegatedDeps)
    }

    if (command === 'docs') {
      return await docsMain(commandArgv, delegatedDeps)
    }

    if (command === 'gc') {
      return await gcMain(commandArgv, delegatedDeps)
    }

    if (command === 'plan') {
      return await planMain(commandArgv, delegatedDeps)
    }

    if (command === 'validate') {
      return await validateMain(commandArgv, delegatedDeps)
    }

    if (command === 'approve') {
      return await approveMain(commandArgv, delegatedDeps)
    }

    if (command === 'catalog') {
      return await catalogMain(commandArgv, delegatedDeps)
    }

    if (command === 'init') {
      return await initMain(commandArgv, delegatedDeps)
    }

    if (command === 'serve') {
      return await serveMain(commandArgv, delegatedDeps)
    }

    if (command === 'eval') {
      return await evalMain(commandArgv, delegatedDeps)
    }

    if (command === 'models') {
      return await modelsMain(commandArgv, delegatedDeps)
    }

    if (command === 'index') {
      return await indexMain(commandArgv, delegatedDeps)
    }

    stderr.write(USAGE)
    return 4
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(msg + '\n')
    return exitCodeOf(err)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
