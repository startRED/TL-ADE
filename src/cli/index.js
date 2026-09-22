// @ts-check
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { main as doctorMain } from './doctor.js'
import { exitCodeOf } from './exit-codes.js'
import { runCommand } from './run.js'
import { main as journalMain } from './journal.js'
import { main as reportMain } from './report.js'
import { main as showMain } from './show.js'
import { main as statusMain } from './status.js'
import { main as docsMain } from './docs.js'
import { main as gcMain } from './gc.js'
import { main as planMain } from './plan.js'
import { main as validateMain } from './validate.js'
import { main as approveMain } from './approve.js'
import { main as catalogMain } from './catalog.js'
import { main as initMain } from './init.js'
import { main as serveMain } from './serve.js'
import { main as indexMain } from './index-command.js'

/**
 * Ponto de entrada e dispatch de subcomandos da CLI.
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

  const delegatedDeps = {
    ...deps,
    stdout,
    stderr,
  }

  try {
    const [command, ...commandArgv] = argv

    if (!command || !['run', 'status', 'journal', 'report', 'show', 'doctor', 'docs', 'gc', 'plan', 'validate', 'approve', 'catalog', 'init', 'serve', 'index'].includes(command)) {
      stderr.write('uso: ade <run|status|journal|report|show|doctor|docs|gc|plan|validate|approve|catalog|init|serve|index> ...\n')
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
        },
      })

      if (!parsed.values.plan) {
        stderr.write('uso: ade run --plan <arquivo> [--repo <pasta>] [--accept-stale-version]\n')
        return 4
      }

      return await runCommand(
        {
          plan: /** @type {string} */ (parsed.values.plan),
          repo: /** @type {string | undefined} */ (parsed.values.repo),
          acceptStaleVersion: Boolean(parsed.values['accept-stale-version']),
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

    if (command === 'index') {
      return await indexMain(commandArgv, delegatedDeps)
    }

    stderr.write('uso: ade <run|status|journal|report|show|doctor|docs|gc|plan|validate|approve|catalog|init|serve|index> ...\n')
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
