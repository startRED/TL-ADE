/* eslint-disable unicorn/no-thenable */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { readCounter } from '../../src/adapters/fake/cli.js'
import { acquireLease } from '../../src/lease/lease.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BIN_ADE = path.resolve(ROOT, 'bin/ade.js')

let repoDirs: string[] = []
let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
  repoDirs = []

  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

interface SetupE2EOptions {
  permittedEffects?: string[]
}

function setupE2E(options: SetupE2EOptions = {}) {
  const repo = makeRepo()
  repoDirs.push(repo.dir)

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
    probed_at: '2026-09-18T00:00:00.000Z',
  }
  fs.writeFileSync(
    path.join(capsDir, 'capabilities.json'),
    JSON.stringify(defaultCaps, null, 2),
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

describe('e2e parity', () => {
  // CA1: Dado um repositório git real com plan.json de uma story trivial e ADE_FAKE_CLI=1,
  // quando node bin/ade.js run --plan <plan.json> --repo <repo> roda, então o processo sai com 0
  // e a branch ade/mission-1/ADE-T1 tem 1 commit novo.
  test('run_plan_executes_one_trivial_story_to_local_commit', async () => {
    const fixture = setupE2E()
    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res.status).toBe(0)

    const logMsg = fixture.repo.git(['log', 'ade/mission-1/ADE-T1', '-1', '--format=%s']).trim()
    expect(logMsg).toBe('ade(ADE-T1): Trivial Story')

    // Afirma no journal step_result ':red:' e ':green:', contain_result, gates_done e pack_manifest
    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('batch_open')
    expect(kinds).toContain('pack_manifest')
    expect(kinds).toContain('contain_result')
    expect(kinds).toContain('gates_done')
    expect(kinds).toContain('story_done')

    const stepResults = events.filter((e) => e.kind === 'step_result')
    const redStep = stepResults.find((e) => String(e.step_id).includes(':red:'))
    const greenStep = stepResults.find((e) => String(e.step_id).includes(':green:'))
    expect(redStep).toBeDefined()
    expect(greenStep).toBeDefined()

    const storyDone = events.find((e) => e.kind === 'story_done')
    expect(storyDone?.data?.status).toBe('committed')
    expect(typeof storyDone?.data?.commit).toBe('string')
  }, 60_000)

  // CA2: Dado um plano com permitted_effects: ['local_write'], quando ade run roda,
  // então sai com 4 e o contador maker da CLI falsa continua 0.
  test('run_refuses_internal_effect_before_dispatch', async () => {
    const fixture = setupE2E({ permittedEffects: ['local_write'] })
    const res = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res.status).toBe(4)
    expect(res.stderr).toContain('classe interna')
    expect(readCounter(fixture.scenarioDir, 'maker')).toBe(0)

    // node bin/ade.js run (sem --plan) -> status 4 e stderr 'uso: ade run --plan <arquivo> ...'
    const resNoPlan = spawnSync(
      process.execPath,
      [BIN_ADE, 'run'],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(resNoPlan.status).toBe(4)
    expect(resNoPlan.stderr).toContain('uso: ade run --plan <arquivo>')
  }, 60_000)

  // CA3: Dado um journal da missão com uma linha adulterada, quando ade run roda de novo,
  // então sai com 2.
  test('tampered_journal_exits_2', async () => {
    const fixture = setupE2E()
    const res1 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res1.status).toBe(0)

    const journalPath = path.join(fixture.missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(2)

    // Altera 1 caractere na linha 2
    const line2 = lines[1]
    const tamperedLine2 = line2.includes('a') ? line2.replace('a', 'b') : line2.replace('1', '2')
    lines[1] = tamperedLine2
    fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8')

    const res2 = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
      { env: fixture.env, encoding: 'utf8' },
    )
    expect(res2.status).toBe(2)
  }, 60_000)

  // CA4: Dado um lease da missão já adquirido por outro dono vivo, quando ade run roda,
  // então sai com 5.
  test('concurrent_lease_exits_5', async () => {
    const fixture = setupE2E()
    const lease = await acquireLease({ missionDir: fixture.missionDir })
    try {
      const res = spawnSync(
        process.execPath,
        [BIN_ADE, 'run', '--plan', fixture.planPath, '--repo', fixture.repo.dir],
        { env: fixture.env, encoding: 'utf8' },
      )
      expect(res.status).toBe(5)
    } finally {
      await lease.release()
    }
  }, 60_000)
})
