// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { dispatchAgy } from '../adapters/agy/index.ts'
import { canonicalize } from '../journal/canonical.ts'
import { planMission } from '../mission/plan-lifecycle.ts'
import { resolveBinary } from '../runner/resolve-binary.ts'

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
    const configPath = path.join(String(repoDir), '.ade', 'config.json')
    let adeConfig = deps.adeConfig
    if (adeConfig === undefined && fs.existsSync(configPath)) {
      adeConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }

    const researchConfig = adeConfig?.research
    let agyResolved = deps.agyResolved
    const researcher = deps.researcher ?? (researchConfig?.enabled === true
      ? async (/** @type {any} */ { unknown, budget }) => {
          if (!agyResolved) agyResolved = (deps.resolveBinary ?? resolveBinary)('agy')
          const missionDir = path.join(String(repoDir), '.ade', 'research')
          fs.mkdirSync(missionDir, { recursive: true })
          return dispatchAgy({
            unit: 'intent-compiler',
            stepId: `research-${unknown.id}`,
            unknown,
            budget,
            resolved: agyResolved,
            cwd: String(repoDir),
            missionDir,
            env: /** @type {Record<string, string>} */ (env),
            ...(deps.runWorkerImpl ? { runWorkerImpl: deps.runWorkerImpl } : {}),
          })
        }
      : undefined)

    const result = await planMission(
      {
        request: String(request),
        repoDir: String(repoDir),
        fromMissionId: fromMissionId ? String(fromMissionId) : undefined,
        nonInteractive,
      },
      {
        ...deps,
        adeConfig,
        researcher,
        policy: deps.policy ?? {
          allow_research: researchConfig?.enabled === true,
          team_enabled: researchConfig?.team_enabled === true,
          team_size: researchConfig?.team_size,
        },
        budget: deps.budget ?? {
          max_usd: researchConfig?.max_usd,
          consumed_usd: 0,
        },
      },
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
