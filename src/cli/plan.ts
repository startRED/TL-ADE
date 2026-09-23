import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { dispatchAgy } from '../adapters/agy/index.ts'
import { canonicalize } from '../journal/canonical.ts'
import { planMission, resumeMissionAnswers } from '../mission/plan-lifecycle.ts'
import { resolveBinary } from '../runner/resolve-binary.ts'

/**
 * Ponto de entrada do comando `ade plan`.
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
      mission: { type: 'string' },
      answers: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const request = values.request || positionals.join(' ').trim()
  const resumeMissionId = values.mission
  const answersPath = values.answers
  const resuming = typeof resumeMissionId === 'string' && typeof answersPath === 'string'
  if (resuming ? request : !request) {
    stderr.write(
      'uso: ade plan [--request <pedido>] [--repo <pasta>] [--from <missao>] [--non-interactive] [--json]\n' +
        '     ade plan --mission <id> --answers <arquivo.json> [--repo <pasta>] [--json]\n',
    )
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
      ? async ( { unknown, budget }: any) => {
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
            env: (env as Record<string, string>),
            ...(deps.runWorkerImpl ? { runWorkerImpl: deps.runWorkerImpl } : {}),
          })
        }
      : undefined)

    const planDeps = {
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
      }
    const result = resuming
      ? await resumeMissionAnswers(
          { missionId: resumeMissionId, repoDir: String(repoDir), answers: JSON.parse(fs.readFileSync(answersPath, 'utf8')) },
          planDeps,
        )
      : await planMission(
          {
            request: String(request),
            repoDir: String(repoDir),
            fromMissionId: fromMissionId ? String(fromMissionId) : undefined,
            nonInteractive,
          },
          planDeps,
        )

    if (values.json) {
      stdout.write(canonicalize(result) + '\n')
    } else if (result.state === 'awaiting_answers') {
      stdout.write(`missão ${result.missionId} aguarda respostas (${result.questions.length} perguntas):\n`)
      for (const q of result.questions) {
        stdout.write(`- ${q.id}: ${q.text}\n`)
        for (const o of q.options) stdout.write(`    ${o.id}: ${o.label}${o.recommended ? ' (recomendada)' : ''}\n`)
      }
      stdout.write(`responda com: ade plan --mission ${result.missionId} --answers <arquivo.json>\n`)
    } else if (result.state === 'awaiting_briefing_approval') {
      stdout.write(`missão ${result.missionId} aguarda aprovação do briefing de produto (digest ${result.digest})\n`)
      stdout.write(`briefing gravado em: ${path.join(String(repoDir), '.ade', 'missions', result.missionId, 'briefing.json')}\n`)
      stdout.write(`aprove com: ade approve --mission ${result.missionId} --digest ${result.digest}\n`)
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
