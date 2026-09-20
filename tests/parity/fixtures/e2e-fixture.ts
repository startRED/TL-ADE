/* eslint-disable unicorn/no-thenable */
import fs, { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCounter } from '../../../src/adapters/fake/cli.js'
import { makeRepo } from '../../helpers/git-repo.js'
import { makeTmpDir } from '../../helpers/tmp-dir.js'

export { readCounter }

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const BIN_ADE = path.resolve(ROOT, 'bin/ade.js')

const tmpDirs: string[] = []

export function cleanupTmpDirs(): void {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export interface SetupE2EOptions {
  permittedEffects?: string[] | unknown
  now?: number
}

export function setupE2E(options: SetupE2EOptions = {}) {
  const now = options.now ?? Date.now()
  const repo = makeRepo()
  tmpDirs.push(repo.dir)

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

  fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, 'tests/check.mjs'), checkCode, 'utf8')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])

  const planDir = makeTmpDir('ade-e2e-plan-')
  tmpDirs.push(planDir)

  const planObj = {
    format_version: 1,
    id: 'plan-1',
    mission_id: 'mission-1',
    immutable_digest: '0123456789abcdef',
    authorization: {
      autonomy: 'safe',
      permitted_effects: options.permittedEffects ?? [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['ADE-T1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 10,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }
  const planPath = path.join(planDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')

  const storiesDir = path.join(planDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  const contractObj = {
    format_version: 1,
    id: 'ADE-T1',
    title: 'Trivial Story',
    complexity: 'bounded',
    task: 'Create src/hello.txt with ok',
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
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
      {
        id: 'C1',
        given: 'initial state without hello.txt',
        when: 'maker creates hello.txt with ok',
        then: 'eval check passes',
        evals: ['E1'],
      },
    ],
    evals: [
      {
        format_version: 1,
        kind: 'test',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
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
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }
  fs.writeFileSync(
    path.join(storiesDir, 'ADE-T1.json'),
    JSON.stringify(contractObj, null, 2),
    'utf8',
  )

  const scenarioDir = makeTmpDir('ade-e2e-scenario-')
  tmpDirs.push(scenarioDir)

  const fakeStdout = JSON.stringify({
    total_cost_usd: 0.01,
    structured_output: {
      format_version: 1,
      story_id: 'ADE-T1',
      state: 'done',
      phase: 'green',
      round: 1,
      tree_before: '0123456789abcdef',
      tree_after: 'fedcba9876543210',
      eval_records: [],
      gate_records: [],
      passes: true,
      reason: 'ok',
      sources: ['contract'],
    },
  })

  const makerActions = [
    {
      files: {
        'src/hello.txt': 'ok\n',
      },
      result: {
        format_version: 1,
        story_id: 'ADE-T1',
        state: 'done',
        phase: 'green',
        round: 1,
        tree_before: '0123456789abcdef',
        tree_after: 'fedcba9876543210',
        eval_records: [],
        gate_records: [],
        passes: true,
        reason: 'ok',
        sources: ['contract'],
      },
      stdout: fakeStdout,
    },
  ]
  fs.writeFileSync(
    path.join(scenarioDir, 'maker.json'),
    JSON.stringify(makerActions, null, 2),
    'utf8',
  )

  // Checker independente (família codex) que aprova citando o eval executado. A árvore e o
  // digest vêm em marcadores: só o motor conhece a revisão de insumos em tempo de execução.
  const checkerActions = [
    {
      result: {
        format_version: 2,
        contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        input_revision: { tree: 'TRUE_TREE', digest: 'TRUE_DIGEST' },
        verdict: 'approved',
        action_items: [],
        deferred: [],
        rejected: [],
        evidence: [
          {
            criterion: 'R1',
            result_ref: 'eval:E1',
            input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
        requested_action: 'verify',
        sources: ['eval:E1'],
        summary: 'eval E1 verde na árvore revisada',
        handoff: {
          claims: [],
          unknowns: [],
          questions_for_owner: [],
          deltas: [],
          next_action: 'verify',
          notes: 'approved',
        },
      },
      stdout: JSON.stringify({ total_cost_usd: 0.01 }),
    },
  ]
  fs.writeFileSync(
    path.join(scenarioDir, 'checker.json'),
    JSON.stringify(checkerActions, null, 2),
    'utf8',
  )

  const adeHome = makeTmpDir('ade-e2e-home-')
  tmpDirs.push(adeHome)

  const capsDir = path.join(adeHome, '.ade')
  fs.mkdirSync(capsDir, { recursive: true })
  const defaultCaps = {
    format_version: 1,
    launch: ['claude'],
    transport: 'cli',
    models: [
      {
        id: 'claude-sonnet-5',
        context_window: 200000,
        effort: 'medium',
        vendor: 'anthropic',
      },
    ],
    resume: true,
    fork: false,
    preminted_session_id: true,
    structured_output: true,
    budget_cap_native: true,
    image_in: false,
    image_out: false,
    sandbox: 'none',
    cost_report: 'reported',
    advisor: false,
    unattended_flags: ['--safe-mode'],
    probe_ok: true,
    probe_mode: 'fixture',
    bootstrap_cost_tokens: 0,
    probed_at: new Date(now).toISOString(),
  }
  fs.writeFileSync(
    path.join(capsDir, 'capabilities.json'),
    JSON.stringify(defaultCaps, null, 2),
    'utf8',
  )
  fs.writeFileSync(
    path.join(capsDir, 'quota-receipt.json'),
    JSON.stringify({
      source: 'official',
      family: 'claude',
      used_percent: 0,
      reserved_percent: 0,
      observed_at: new Date(now).toISOString(),
      weekly_reset_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    'utf8',
  )

  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-1')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADE_FAKE_CLI: '1',
    ADE_FAKE_SCENARIO: scenarioDir,
    ADE_HOME: adeHome,
  }

  return {
    repo,
    planDir,
    planPath,
    scenarioDir,
    adeHome,
    missionDir,
    env,
  }
}
