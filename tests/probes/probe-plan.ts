import fs from 'node:fs'
import path from 'node:path'
import { observedUsd } from '../../src/engine/budget.js'

/**
 * Grava o ambiente de testes mínimo no repositório de destino da probe.
 *
 * @param {string} repoDir
 * @returns {void}
 */
export function writeProbeSandbox(repoDir: string): void {
  const testsDir = path.join(repoDir, 'tests')
  const srcDir = path.join(repoDir, 'src')
  fs.mkdirSync(testsDir, { recursive: true })
  fs.mkdirSync(srcDir, { recursive: true })
  const checkCode = [
    "import fs from 'node:fs'",
    'let ok = false',
    'try {',
    "  const content = fs.readFileSync('src/hello.txt', 'utf8')",
    "  ok = content.includes('ok')",
    '} catch {}',
    'if (ok) {',
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }) + "\\n")',
    '  process.exit(0)',
    '} else {',
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1 }) + "\\n")',
    '  process.exit(1)',
    '}',
  ].join('\n')
  fs.writeFileSync(path.join(testsDir, 'check.mjs'), checkCode, 'utf8')
  fs.writeFileSync(path.join(srcDir, 'check.mjs'), checkCode, 'utf8')
}

/**
 * Grava um plan.json e stories/PROBE-1.json configurados para a prova real com baixo teto de orçamento.
 *
 * @param {string} planDir
 * @returns {string} Caminho absoluto para plan.json
 */
export function writeProbePlan(planDir: string): string {
  const planObj = {
    format_version: 1,
    id: 'probe-plan',
    mission_id: 'probe-m1',
    immutable_digest: '0123456789abcdef',
    authorization: {
      autonomy: 'safe',
      permitted_effects: [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['PROBE-1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 1,
      max_wall_clock_seconds: 3600,
      max_parked_units: 1,
    },
    budget: {
      max_model_calls: 3,
      max_rework_rounds: 1,
    },
  }

  const planPath = path.join(planDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')

  const storiesDir = path.join(planDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  const contractObj = {
    format_version: 1,
    id: 'PROBE-1',
    title: 'Trivial Story',
    complexity: 'bounded',
    task: 'Crie o arquivo src/hello.txt contendo a palavra ok',
    guardrails: {
      scope_paths: ['src/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN check runs THE SYSTEM SHALL pass.',
      },
    ],
    scenarios: [
      Object.assign(
        {
          id: 'C1',
          given: 'initial state without hello.txt',
          when: 'maker creates hello.txt with ok',
          evals: ['E1'],
        },
        JSON.parse('{"then":"eval check passes"}'),
      ),
    ],
    evals: [
      {
        format_version: 1,
        kind: 'test',
        cmd: ['node', 'src/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['src/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    skills: [],
    roles: {
      maker: {
        family: 'claude',
        model_id: 'claude-sonnet-5',
      },
      checker_round: {
        family: 'codex',
        model_id: 'codex-1',
      },
    },
    budget: {
      max_model_calls: 3,
      max_rework_rounds: 1,
    },
  }

  fs.writeFileSync(
    path.join(storiesDir, 'PROBE-1.json'),
    JSON.stringify(contractObj, null, 2),
    'utf8',
  )

  return planPath
}

/**
 * Remove variáveis de ambiente de teste falso e retorna cópia rasa do ambiente.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function probeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next = { ...env }
  delete next.ADE_FAKE_CLI
  delete next.ADE_FAKE_SCENARIO
  delete next.ADE_HOME
  return next
}

/**
 * Verifica eventos do diário da probe e retorna lista dos itens faltantes na ordem fixa.
 *
 * @param {any} rawEvents
 * @returns {string[]}
 */
export function checkProbeJournal(rawEvents: any): string[] {
  const events: any[] = Array.isArray(rawEvents)
    ? rawEvents
    : Array.isArray(rawEvents?.events)
      ? rawEvents.events
      : []

  const missing: string[] = []

  const hasStoryDone = events.some(
    (e: any) => e?.kind === 'story_done' && e?.data?.status === 'committed',
  )
  if (!hasStoryDone) {
    missing.push('story_done')
  }

  const { observed_usd } = observedUsd(events)
  if (!(typeof observed_usd === 'number' && observed_usd > 0 && observed_usd <= 1)) {
    missing.push('observed_usd')
  }

  const hasPackDedup = events.some(
    (e: any) => e?.kind === 'pack_manifest' && e?.data?.dedup != null,
  )
  if (!hasPackDedup) {
    missing.push('pack_dedup')
  }

  const hasTokensReported = events.some(
    (e: any) => e?.kind === 'telemetry' && e?.data?.tokens?.source === 'reported',
  )
  if (!hasTokensReported) {
    missing.push('tokens_reported')
  }

  return missing
}
