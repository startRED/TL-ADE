import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLocalPreflightPorts } from '../src/adapters/local/preflight.ts'
import { runStory } from '../src/engine.ts'
import { runPreflight } from '../src/engine/preflight.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { removeTmpDir } from './helpers/tmp-dir.ts'

let repoDirs: string[] = []
let tmpDirs: string[] = []
let openJournals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const j of openJournals) {
    try {
      await j.close()
    } catch {
      // Ignora falhas de encerramento do journal
    }
  }
  openJournals = []

  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // Ignora falhas de limpeza de repo
    }
  }
  repoDirs = []

  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // Ignora falhas de limpeza de diretórios temporários
    }
  }
  tmpDirs = []
})

function buildContract(overrides: Record<string, any> = {}) {
  return {
    format_version: 2,
    id: 'ADE-T1',
    title: 'Preflight Story',
    complexity: 'bounded',
    task: 'Run preflight verification',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: ['repo:tests/a.test.ts'],
    },
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN preflight runs THE SYSTEM SHALL verify ready state.',
      },
    ],
    scenarios: [
      Object.assign(
        {
          id: 'C1',
          given: 'clean worktree and valid environment',
          when: 'preflight evaluates checks',
          evals: ['E1'],
          verifiers: ['V1'],
        },
        JSON.parse('{"then":"all ports are ready"}'),
      ),
    ],
    verifiers: [
      {
        id: 'V1',
        kind: 'script',
        cmd: ['node', 'tests/a.test.ts'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/a.test.ts'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    unknowns: [],
    evals: [
      {
        format_version: 1,
        kind: 'script',
        cmd: ['node', 'tests/a.test.ts'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/a.test.ts'],
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
      max_model_calls: 4,
      max_rework_rounds: 2,
    },
    ...overrides,
  }
}

function buildLoadedPlan(contract: any, planMaxCalls = 6): any {
  return {
    planDir: '',
    gates: [],
    plan: {
      format_version: 2,
      id: 'plan-preflight',
      mission_id: 'mission-preflight-1',
      direction: 'verify preflight',
      next_delivery: 'tests pass',
      intent: 'verify preflight integration',
      briefing: 'preflight checks',
      unknowns: [],
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
              stories: [contract.id],
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
        max_model_calls: planMaxCalls,
        max_rework_rounds: 2,
      },
    },
    missionBudget: {
      max_usd: 10,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    },
    stories: [
      {
        id: contract.id,
        spec_revision: 'r1',
        contract,
        evals: contract.evals,
      },
    ],
  }
}

describe('preflight integration', () => {
  // CA1 — Dada uma story com alvo existente, dependências instaladas, build verde,
  // árvore limpa, contrato válido, credencial real, 1 GiB livre e acesso recente,
  // quando runStory inicia, então o preflight é registrado antes de budget_reserved
  // e o fluxo alcança exatamente um despacho.
  // EXEMPLO: {evals:[{evidence:['tests/a.test.ts']}],node_modules:true,build:0,dirtyPaths:[],apiKey:'x',freeBytes:1073741824,probed_at:0,now:1}
  //          → {events:['preflight_result','budget_reserved','prepare','dispatch'],dispatches:1}
  test('CA1_preflight_recorded_before_budget_reserved_and_dispatches_once', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    // Alvo de prova tests/a.test.ts
    fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, 'tests/a.test.ts'), '// test target', 'utf8')
    // dependências node_modules
    fs.mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
    // package.json sem scripts.build
    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf8')

    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'initial commit'])

    const contract = buildContract()
    const loaded = buildLoadedPlan(contract, 6)
    const story = loaded.stories[0]

    const missionDir = path.join(repo.dir, '.ade', 'missions', loaded.plan.mission_id)
    fs.mkdirSync(missionDir, { recursive: true })
    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    openJournals.push(journal)

    const eventsAppended: string[] = []
    const rawEventsAppended: any[] = []
    const origAppend = journal.append.bind(journal)
    journal.append = async (evt: any) => {
      eventsAppended.push(evt.kind)
      rawEventsAppended.push(evt)
      return origAppend(evt)
    }

    const prepareStorySpy = vi.fn().mockResolvedValue({
      status: 'ready',
      worktreeDir: repo.dir,
    })

    const dispatchClaudeSpy = vi.fn().mockResolvedValue({
      status: 'ready',
      exitCode: 0,
      verdict: 'green',
      telemetry: {},
    })

    const gitPort = {
      dirtyPaths: vi.fn().mockResolvedValue([]),
      worktreeTree: vi.fn().mockResolvedValue('0123456789abcdef'),
    }

    const fakeStatfs = vi.fn().mockResolvedValue({
      bavail: 1073741824n,
      bsize: 1n,
    })

    const capabilities = {
      probe_ok: true,
      probed_at: 0,
    }
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: 'x',
      CI: 'true',
    }
    const now = () => 1

    const deps: any = {
      journal,
      step: async (spec: any, effectFn: any) => {
        if (spec.effect_class === 'prepare') {
          eventsAppended.push('prepare')
          const result = await effectFn()
          return { step_id: spec.id, status: 'ok', result, reused: false }
        }
        if (spec.effect_class === 'model_call') {
          eventsAppended.push('dispatch')
          const result = await effectFn()
          return { step_id: spec.id, status: 'ok', result, reused: false }
        }
        const result = await effectFn()
        return { step_id: spec.id, status: 'ok', result, reused: false }
      },
      gitPortFor: () => gitPort,
      prepareStory: prepareStorySpy,
      createEvalRunner: () => ({
        runEval: async () => ({ verdict: 'red_valid' }),
      }),
      createGateRunner: () => ({
        runGates: async () => ({}),
      }),
      compilePack: () => ({
        manifest: { bytes: 1 },
        manifest_path: '',
        pack_path: '',
      }),
      contain: async () => ({ ok: true }),
      plantCanary: async () => ({}),
      checkCanary: async () => ({}),
      dispatchClaude: async (args: any) => {
        return deps.step(
          {
            unit: story.id,
            id: `${story.id}:r1:maker`,
            effect_class: 'model_call',
            input: {},
          },
          () => dispatchClaudeSpy(args),
        )
      },
      resolved: { exe: process.execPath, prefixArgs: [] },
      workerEnv: {},
      quotaPort: { readReceipt: async () => ({ source: 'official', family: 'claude', used_percent: 0, reserved_percent: 0, observed_at: new Date(0).toISOString(), weekly_reset_at: new Date(86400000).toISOString() }) },
      capabilities,
      env,
      now,
      preflight: async ({ story, loaded, repoDir, events }: any) => {
        const checks = createLocalPreflightPorts({
          repoDir,
          story,
          loaded,
          capabilities,
          gitPort,
          execFile: vi.fn(),
          statfs: fakeStatfs,
          now,
          env,
        })
        const planned_paid_calls = Math.min(
          loaded.plan.budget.max_model_calls,
          story.contract.budget.max_model_calls,
        )
        const consumed_paid_calls = events.filter((e: any) => e.kind === 'budget_reserved').length
        return runPreflight({
          checks,
          planned_paid_calls,
          consumed_paid_calls,
        })
      },
    }

    await runStory(deps, {
      loaded,
      story,
      repoDir: repo.dir,
      missionDir,
    })

    // preflight_result deve vir antes de budget_reserved
    const preflightIdx = eventsAppended.indexOf('preflight_result')
    const budgetReservedIdx = eventsAppended.indexOf('budget_reserved')
    const prepareIdx = eventsAppended.indexOf('prepare')
    const dispatchIdx = eventsAppended.indexOf('dispatch')

    expect(preflightIdx).toBeGreaterThanOrEqual(0)
    expect(budgetReservedIdx).toBeGreaterThan(preflightIdx)
    expect(prepareIdx).toBeGreaterThan(budgetReservedIdx)
    expect(dispatchIdx).toBeGreaterThan(prepareIdx)

    expect(dispatchClaudeSpy).toHaveBeenCalledTimes(1)
  })

  // CA2 — Dado qualquer check bloqueado, quando runStory inicia, então termina awaiting_operator
  // com reason:'preflight', exitCode 3, nenhum budget_reserved, nenhum prepare e nenhum despacho.
  // EXEMPLO: {disk:{status:'blocked',reason:'espaço insuficiente'}}
  //          → {status:'awaiting_operator',reason:'preflight',exitCode:3,budget_reserved:0,prepare:0,dispatch:0}
  test('CA2_blocked_check_aborts_before_budget_reserve_prepare_and_dispatch', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    const contract = buildContract()
    const loaded = buildLoadedPlan(contract, 6)
    const story = loaded.stories[0]

    const missionDir = path.join(repo.dir, '.ade', 'missions', loaded.plan.mission_id)
    fs.mkdirSync(missionDir, { recursive: true })
    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    openJournals.push(journal)

    const prepareStorySpy = vi.fn()
    const dispatchClaudeSpy = vi.fn()

    const deps: any = {
      journal,
      step: vi.fn(),
      gitPortFor: vi.fn(),
      prepareStory: prepareStorySpy,
      createEvalRunner: vi.fn(),
      createGateRunner: vi.fn(),
      compilePack: vi.fn(),
      contain: vi.fn(),
      plantCanary: vi.fn(),
      checkCanary: vi.fn(),
      dispatchClaude: dispatchClaudeSpy,
      resolved: { exe: process.execPath, prefixArgs: [] },
      workerEnv: {},
      quotaPort: { readReceipt: async () => ({ source: 'official', family: 'claude', used_percent: 0, reserved_percent: 0, observed_at: new Date(0).toISOString(), weekly_reset_at: new Date(86400000).toISOString() }) },
      capabilities: { probe_ok: true, probed_at: 0 },
      env: { ...process.env, ANTHROPIC_API_KEY: 'x', CI: 'true' },
      now: () => 1,
      preflight: async () => ({
        ready: false,
        failures: [{ id: 'disk', reason: 'espaço insuficiente' }],
        checks: [
          { id: 'proof_target', status: 'ready', reason: null },
          { id: 'dependencies', status: 'ready', reason: null },
          { id: 'build', status: 'ready', reason: null },
          { id: 'worktree', status: 'ready', reason: null },
          { id: 'input', status: 'ready', reason: null },
          { id: 'credential', status: 'ready', reason: null },
          { id: 'disk', status: 'blocked', reason: 'espaço insuficiente' },
          { id: 'external_access', status: 'ready', reason: null },
        ],
        calls_avoided: 4,
      }),
    }

    const result = await runStory(deps, {
      loaded,
      story,
      repoDir: repo.dir,
      missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('preflight')
    expect(result.exitCode).toBe(3)

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const budgetReservedEvents = events.filter((e) => e.kind === 'budget_reserved')
    expect(budgetReservedEvents.length).toBe(0)
    expect(prepareStorySpy).not.toHaveBeenCalled()
    expect(dispatchClaudeSpy).not.toHaveBeenCalled()
  })

  // CA3 — Dadas duas falhas simultâneas, quando o preflight termina, então ambas aparecem no journal
  // na ordem canônica e calls_avoided contém o orçamento restante calculado.
  // EXEMPLO: {proof_target:'blocked',dependencies:'blocked',plan_max:6,story_max:4,budget_reserved_events:2}
  //          → {failures:['proof_target','dependencies'],calls_avoided:2}
  test('CA3_multiple_failures_appear_in_canonical_order_with_calls_avoided', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)

    const contract = buildContract({
      budget: { max_model_calls: 4, max_rework_rounds: 2 },
    })
    const loaded = buildLoadedPlan(contract, 6)
    const story = loaded.stories[0]

    const missionDir = path.join(repo.dir, '.ade', 'missions', loaded.plan.mission_id)
    fs.mkdirSync(missionDir, { recursive: true })
    const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    openJournals.push(journal)

    // Injeta 2 eventos budget_reserved anteriores
    await journal.append({ kind: 'batch_open', data: { plan_id: loaded.plan.id } })
    await journal.append({ kind: 'budget_reserved', unit: story.id, data: { calls: 1 } })
    await journal.append({ kind: 'budget_reserved', unit: story.id, data: { calls: 1 } })

    const deps: any = {
      journal,
      step: vi.fn(),
      gitPortFor: vi.fn(),
      prepareStory: vi.fn(),
      createEvalRunner: vi.fn(),
      createGateRunner: vi.fn(),
      compilePack: vi.fn(),
      contain: vi.fn(),
      plantCanary: vi.fn(),
      checkCanary: vi.fn(),
      dispatchClaude: vi.fn(),
      resolved: { exe: process.execPath, prefixArgs: [] },
      workerEnv: {},
      quotaPort: { readReceipt: async () => ({ source: 'official', family: 'claude', used_percent: 0, reserved_percent: 0, observed_at: new Date(0).toISOString(), weekly_reset_at: new Date(86400000).toISOString() }) },
      capabilities: { probe_ok: true, probed_at: 0 },
      env: { ...process.env, ANTHROPIC_API_KEY: 'x', CI: 'true' },
      now: () => 1,
      preflight: async ({ story, loaded, events }: any) => {
        const checks: any = {
          proof_target: { check: () => ({ status: 'blocked', reason: 'alvo inexistente' }) },
          dependencies: { check: () => ({ status: 'blocked', reason: 'dependências ausentes' }) },
          build: { check: () => ({ status: 'ready', reason: null }) },
          worktree: { check: () => ({ status: 'ready', reason: null }) },
          input: { check: () => ({ status: 'ready', reason: null }) },
          credential: { check: () => ({ status: 'ready', reason: null }) },
          disk: { check: () => ({ status: 'ready', reason: null }) },
          external_access: { check: () => ({ status: 'ready', reason: null }) },
        }
        const planned_paid_calls = Math.min(
          loaded.plan.budget.max_model_calls,
          story.contract.budget.max_model_calls,
        )
        const consumed_paid_calls = events.filter((e: any) => e.kind === 'budget_reserved').length
        return runPreflight({
          checks,
          planned_paid_calls,
          consumed_paid_calls,
        })
      },
    }

    const result = await runStory(deps, {
      loaded,
      story,
      repoDir: repo.dir,
      missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('preflight')

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const preflightEvent = events.find((e) => e.kind === 'preflight_result')
    expect(preflightEvent).toBeDefined()

    const data: any = preflightEvent?.data
    expect(data.status).toBe('blocked')
    expect(data.failures.map((f: any) => f.id)).toEqual(['proof_target', 'dependencies'])
    expect(data.calls_avoided).toBe(2)
  })

  // CA4 — Dado erro do sistema ao consultar disco, Git, dependências, build ou capacidade,
  // quando o adaptador avalia a story, então o check correspondente fica blocked com diagnóstico
  // em português sem segredo, caminho externo ou stack trace.
  // EXEMPLO: {statfs:'throws EPERM'} → {disk:{status:'blocked',reason:'não foi possível verificar espaço livre'}}
  test('CA4_system_error_returns_blocked_with_portuguese_diagnosis', async () => {
    const contract = buildContract()
    const loaded = buildLoadedPlan(contract)
    const story = loaded.stories[0]

    // Disco que lança EPERM
    const portsDiskError = createLocalPreflightPorts({
      repoDir: '/dummy/path/with/secret/stuff',
      story,
      loaded,
      capabilities: { probe_ok: true, probed_at: 0 },
      gitPort: { dirtyPaths: async () => [] },
      execFile: vi.fn(),
      statfs: () => {
        const err: any = new Error('EPERM: operation not permitted')
        err.code = 'EPERM'
        throw err
      },
      now: () => 1,
      env: { ANTHROPIC_API_KEY: 'sk-secret-key-12345' },
    })

    const diskResult = await portsDiskError.disk.check()
    expect(diskResult.status).toBe('blocked')
    expect(diskResult.reason).toBe('não foi possível verificar espaço livre')
    expect(diskResult.reason).not.toMatch(/secret|dummy|stack|EPERM/i)

    // Git que lança erro
    const portsGitError = createLocalPreflightPorts({
      repoDir: '/dummy/repo',
      story,
      loaded,
      capabilities: { probe_ok: true, probed_at: 0 },
      gitPort: {
        dirtyPaths: () => {
          throw new Error('git fatal: broken pipe')
        },
      },
      execFile: vi.fn(),
      statfs: () => ({ bavail: 1073741824n, bsize: 1n }),
      now: () => 1,
      env: { ANTHROPIC_API_KEY: 'secret-token' },
    })

    const gitResult = await portsGitError.worktree.check()
    expect(gitResult.status).toBe('blocked')
    expect(gitResult.reason).toBe('não foi possível verificar estado da worktree')
    expect(gitResult.reason).not.toMatch(/secret|token|stack/i)

    // Build que lança erro
    const portsBuildError = createLocalPreflightPorts({
      repoDir: '/dummy/repo',
      story,
      loaded,
      capabilities: { probe_ok: true, probed_at: 0 },
      gitPort: { dirtyPaths: async () => [] },
      execFile: (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('build error: failed to compile'))
      },
      statfs: () => ({ bavail: 1073741824n, bsize: 1n }),
      now: () => 1,
      env: { ANTHROPIC_API_KEY: 'secret-token' },
      fs: {
        existsSync: (p: string) => p.includes('package.json'),
        readFileSync: () => JSON.stringify({ scripts: { build: 'tsc' } }),
      },
    })

    const buildResult = await portsBuildError.build.check()
    expect(buildResult.status).toBe('blocked')
    expect(buildResult.reason).toBe('falha na execução do build')
    expect(buildResult.reason).not.toMatch(/secret|stack|failed to compile/i)
  })

  test('CA5_external_access_requires_a_real_fresh_doctor_probe', async () => {
    const contract = buildContract()
    const loaded = buildLoadedPlan(contract)
    const story = loaded.stories[0]
    const options = (capabilities: any) => createLocalPreflightPorts({
      repoDir: '/dummy/repo', story, loaded, capabilities,
      gitPort: { dirtyPaths: async () => [] }, execFile: vi.fn(),
      statfs: () => ({ bavail: 1073741824n, bsize: 1n }), now: () => 86400000,
      env: { ANTHROPIC_API_KEY: 'x' },
    })

    await expect(options({ probe_ok: null }).external_access.check()).resolves.toMatchObject({
      status: 'blocked', reason: expect.stringContaining('ade doctor'),
    })
    await expect(options({ probe_ok: true, probed_at: 0 }).external_access.check()).resolves.toMatchObject({
      status: 'ready', reason: null,
    })
    await expect(options({ probe_ok: true, probed_at: -1 }).external_access.check()).resolves.toMatchObject({
      status: 'blocked', reason: expect.stringContaining('ade doctor'),
    })
  })

  test('projeto_sem_dependencia_declarada_nao_precisa_de_node_modules', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    const contract = buildContract()
    const loaded = buildLoadedPlan(contract)
    const ports = () => createLocalPreflightPorts({ repoDir: repo.dir, story: loaded.stories[0], loaded, capabilities: { probe_ok: true, probed_at: 0 }, gitPort: { dirtyPaths: async () => [] }, execFile: vi.fn(), now: () => 1, env: {} })

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'tarefas', scripts: { test: 'node --test tests/' } }))
    await expect(ports().dependencies.check()).resolves.toEqual({ status: 'ready', reason: null })

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'tarefas', devDependencies: { vitest: '^3.0.0' } }))
    await expect(ports().dependencies.check()).resolves.toEqual({ status: 'blocked', reason: 'dependências ausentes' })
  })

  test('login_do_cli_provado_pela_sonda_real_vale_como_credencial_sem_chave_de_api', async () => {
    const repo = makeRepo()
    repoDirs.push(repo.dir)
    const loaded = buildLoadedPlan(buildContract())
    const credential = (capabilities: any) => createLocalPreflightPorts({ repoDir: repo.dir, story: loaded.stories[0], loaded, capabilities, gitPort: { dirtyPaths: async () => [] }, execFile: vi.fn(), now: () => 1, env: {} }).credential.check()
    await expect(credential({ probe_ok: true, probe_mode: 'real', probed_at: 0 })).resolves.toEqual({ status: 'ready', reason: null })
    await expect(credential({ probe_ok: null, probe_mode: 'help_only', probed_at: 0 })).resolves.toEqual({ status: 'blocked', reason: 'credencial ausente ou vazia' })
  })
})
