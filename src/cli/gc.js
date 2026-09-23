// @ts-check
import { parseArgs } from 'node:util'
import { gcDocs } from '../docs/projection.ts'
import { exitCodeOf } from './exit-codes.js'

/**
 * CLI para sugestão de limpeza documental: `ade gc --docs [--repo <dir>]`
 *
 * @param {string[]} argv
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   env?: Record<string, string | undefined>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: false,
    options: {
      docs: { type: 'boolean' },
      repo: { type: 'string' },
    },
  })

  if (!parsed.values.docs) {
    stderr.write('uso: ade gc --docs [--repo <pasta>]\n')
    return 4
  }

  const repoDir = parsed.values.repo ? String(parsed.values.repo) : process.cwd()

  try {
    const result = gcDocs({ repoDir })
    stdout.write(`Sugestões de limpeza documental (nenhum arquivo foi apagado automaticamente):\n`)
    if (result.suggestions.length === 0) {
      stdout.write(`Nenhuma inconsistência encontrada.\n`)
    } else {
      for (const s of result.suggestions) {
        stdout.write(`[${s.action}] ${s.file}: ${s.detail}\n`)
      }
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`ade gc falhou: ${msg}\n`)
    return exitCodeOf(err)
  }
}
