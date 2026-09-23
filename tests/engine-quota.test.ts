import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.ts'
import { AdeError } from '../src/journal/errors.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

const NOW = Date.parse('2026-09-20T00:00:00.000Z')
const RECEIPT = {
  source: 'official',
  family: 'claude',
  used_percent: 20,
  reserved_percent: 10,
  observed_at: '2026-09-20T00:00:00.000Z',
  weekly_reset_at: '2026-09-27T00:00:00.000Z',
}

const repos: string[] = []
const journals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  for (const repo of repos.splice(0)) removeRepo(repo)
})

function fixture(options: { receipt?: any; maxUsd?: number; quotaPort?: any; packBytes?: number } = {}) {
  const repo = makeRepo()
  repos.push(repo.dir)
  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-quota')
  fs.mkdirSync(missionDir, { recursive: true })
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  journals.push(journal)
  const sequence: string[] = []
  const dispatched = vi.fn().mockImplementation(async (opts?: any) => {
    sequence.push('dispatch')
    if (opts?.cwd) {
      fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true })
      fs.writeFileSync(path.join(opts.cwd, 'src', 'work.txt'), 'ok\n', 'utf8')
    }
    return {}
  })
  const prepared = vi.fn().mockResolvedValue({ status: 'ready', worktreeDir: repo.dir })
  const quotaPort = options.quotaPort === undefined
    ? { readReceipt: vi.fn().mockResolvedValue(Object.hasOwn(options, 'receipt') ? options.receipt : RECEIPT) }
    : options.quotaPort
  const story = {
    id: 'ADE-Q1',
    spec_revision: 'r1',
    evals: [],
    contract: {
      roles: { maker: { family: 'claude' } },
      budget: { max_model_calls: 2, max_usd: options.maxUsd ?? 25 },
      guardrails: { scope_paths: [], do_not_touch: [] },
    },
  }
  const loaded = {
    plan: { id: 'plan-quota', mission_id: 'mission-quota', budget: { max_model_calls: 2 } },
    missionBudget: { max_usd: 300, max_model_calls: 2, max_wall_clock_seconds: 28800, max_parked_units: 3 },
    gates: [],
  }
  const deps: any = {
    journal,
    quotaPort,
    step: async (spec: any, effect: any) => {
      if (spec.effect_class === 'prepare') sequence.push('prepare')
      return { step_id: spec.id, status: 'ok', result: await effect(), reused: false }
    },
    gitPortFor: () => ({ worktreeTree: async () => 'tree' }),
    prepareStory: prepared,
    createEvalRunner: () => ({ runEval: async () => ({ verdict: 'red_valid' }) }),
    createGateRunner: () => ({ runGates: async () => ({ ok: true, results: [] }) }),
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: { bytes: options.packBytes ?? 1 } }),
    contain: async () => ({ ok: false, reason: 'stop_after_dispatch' }),
    plantCanary: async () => ({}),
    checkCanary: async () => ({ escaped: false }),
    dispatchClaude: dispatched,
    resolved: { exe: process.execPath, prefixArgs: [] },
    workerEnv: {},
    capabilities: { probe_ok: true },
    env: { CI: 'true' },
    now: () => NOW,
    preflight: async () => ({ ready: true, failures: [], checks: [], calls_avoided: 0 }),
  }
  const append = journal.append.bind(journal)
  journal.append = async (event: any) => {
    if (event.kind === 'budget_reserved') sequence.push('reserved')
    return append(event)
  }
  return { deps, dispatched, journal, loaded, missionDir, prepared, repoDir: repo.dir, sequence, story }
}

async function run(subject: ReturnType<typeof fixture>) {
  return runStory(subject.deps, {
    loaded: subject.loaded as any,
    story: subject.story,
    repoDir: subject.repoDir,
    missionDir: subject.missionDir,
  })
}

test('CA1_official_receipt_reserves_before_one_dispatch', async () => {
  const subject = fixture()
  await run(subject)
  const events = readJournal(path.join(subject.missionDir, 'journal.jsonl')).events
  const reserveIndex = events.findIndex((event) => event.kind === 'budget_reserved')
  expect(events[reserveIndex].data).toMatchObject({
    calls: 1,
    usd: 25,
    turns: 1,
    family: 'claude',
    phase: 'implementation',
    quota_receipt: RECEIPT,
  })
  expect(reserveIndex).toBeGreaterThanOrEqual(0)
  expect(subject.sequence).toEqual(expect.arrayContaining(['reserved', 'prepare', 'dispatch']))
  expect(subject.sequence.indexOf('reserved')).toBeLessThan(subject.sequence.indexOf('prepare'))
  expect(subject.sequence.indexOf('prepare')).toBeLessThan(subject.sequence.indexOf('dispatch'))
  expect(subject.dispatched).toHaveBeenCalledTimes(1)
  expect(subject.dispatched).toHaveBeenCalledWith(expect.objectContaining({
    maxBudgetUsd: 25,
    authorization: expect.objectContaining({ reservation: expect.objectContaining({ usd: 25 }) }),
  }))
})

test('CA2_missing_quota_port_fails_closed_without_effects', async () => {
  const subject = fixture({ quotaPort: undefined })
  delete subject.deps.quotaPort
  await expect(run(subject)).rejects.toMatchObject({ code: 'quota_port_missing', exitCode: 4 } satisfies Partial<AdeError>)
  expect(subject.prepared).not.toHaveBeenCalled()
  expect(subject.dispatched).not.toHaveBeenCalled()
  expect(readJournal(path.join(subject.missionDir, 'journal.jsonl')).events.some((event) => event.kind === 'budget_reserved')).toBe(false)
})

test('CA3_missing_or_exhausted_receipts_park_without_dispatch', async () => {
  for (const [receipt, reason] of [
    [null, 'quota_unavailable'],
    [{ ...RECEIPT, source: 'estimated' }, 'quota_untrusted'],
    [{ ...RECEIPT, observed_at: '2026-09-18T00:00:00.000Z' }, 'quota_unavailable'],
    [{ ...RECEIPT, used_percent: 45, reserved_percent: 5 }, 'quota_exhausted'],
  ] as const) {
    const subject = fixture({ receipt })
    const result = await run(subject)
    expect(result).toMatchObject({ status: 'awaiting_operator', exitCode: 3 })
    expect(result.reason).toBe(reason)
    expect(subject.dispatched).not.toHaveBeenCalled()
  }
})

test('CA4_absolute_cap_parks_and_resume_reuses_official_reservation', async () => {
  const capped = fixture({ maxUsd: 5 })
  await capped.journal.append({ kind: 'step_result', unit: 'old', step_id: 'old:r1:maker', data: { cost_usd: 275 } })
  await capped.journal.append({ kind: 'budget_reserved', unit: 'other', data: { unit: 'other', usd: 20, calls: 1 } })
  await expect(run(capped)).resolves.toMatchObject({ status: 'awaiting_operator', reason: 'absolute_usd_cap' })
  expect(capped.dispatched).not.toHaveBeenCalled()

  const resumed = fixture()
  await resumed.journal.append({
    kind: 'budget_reserved',
    unit: resumed.story.id,
    data: { unit: resumed.story.id, calls: 1, usd: 25, turns: 1, family: 'claude', phase: 'implementation', quota_receipt: RECEIPT },
  })
  await run(resumed)
  const reservations = readJournal(path.join(resumed.missionDir, 'journal.jsonl')).events.filter((event) => event.kind === 'budget_reserved')
  expect(reservations).toHaveLength(1)
  expect(resumed.deps.quotaPort.readReceipt).not.toHaveBeenCalled()
})

test('CA3_unavailable_local_adapter_never_fabricates_a_receipt', async () => {
  const { createLocalQuotaPort } = await import('../src/adapters/local/quota.ts')
  await expect(createLocalQuotaPort().readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()

  const subject = fixture()
  const receiptPath = path.join(subject.repoDir, 'quota-receipt.json')
  fs.writeFileSync(receiptPath, JSON.stringify(RECEIPT), 'utf8')
  await expect(createLocalQuotaPort({ receiptPath }).readReceipt({ family: 'claude', now: NOW })).resolves.toEqual(RECEIPT)

  fs.writeFileSync(receiptPath, '{', 'utf8')
  await expect(createLocalQuotaPort({ receiptPath }).readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()
})

function makePlanFixture(repoDir: string) {
  fs.mkdirSync(path.join(repoDir, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.git', 'info', 'exclude'), '.ade\nnode_modules\nquota-receipt.json\n', 'utf8')
  fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true })

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

  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'tests', 'check.mjs'), checkCode, 'utf8')

  try {
    const { execFileSync } = require('node:child_process')
    fs.writeFileSync(path.join(repoDir, '.gitkeep'), '', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir })
  } catch {}
  const planDir = path.join(repoDir, '.ade', 'plan-quota')
  const storiesDir = path.join(planDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })
  const planPath = path.join(planDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify({
    format_version: 2,
    id: 'plan-quota',
    mission_id: 'mission-quota',
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
            stories: ['ADE-Q1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 300,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    },
    budget: {
      max_model_calls: 2,
      max_rework_rounds: 2,
    },
  }, null, 2), 'utf8')

  fs.writeFileSync(path.join(storiesDir, 'ADE-Q1.json'), JSON.stringify({
    format_version: 2,
    id: 'ADE-Q1',
    title: 'Quota Story',
    complexity: 'bounded',
    task: 'Test task',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: [],
    },
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN something happens THE SYSTEM SHALL behave.',
      },
    ],
    scenarios: [
      {
        id: 'C1',
        given: 'initial state',
        when: 'action taken',
        then: 'result verified',
        verifiers: ['E1'],
        evals: ['E1'],
      },
    ],
    verifiers: [
      {
        id: 'E1',
        kind: 'script',
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
    evals: [
      {
        id: 'E1',
        kind: 'script',
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
      max_model_calls: 2,
      max_usd: 25,
      max_rework_rounds: 2,
    },
  }, null, 2), 'utf8')

  const capsDir = path.join(repoDir, '.ade')
  fs.writeFileSync(path.join(capsDir, 'capabilities.json'), JSON.stringify({
    probe_ok: true,
    probed_at: new Date(NOW).toISOString(),
  }), 'utf8')

  return { planPath }
}

test('CA1_recibo_oficial_valido_permite_despacho_do_cli_ao_runner_dentro_dos_limites', async () => {
  const { runCommand } = await import('../src/cli/run.ts')
  const subject = fixture()
  const { planPath } = makePlanFixture(subject.repoDir)

  const exitCode = await runCommand(
    { plan: planPath, repo: subject.repoDir, acceptStaleVersion: false },
    {
      env: { ADE_HOME: subject.repoDir, CI: 'true' } as any,
      quotaPort: subject.deps.quotaPort,
      dispatchClaude: subject.deps.dispatchClaude,
      now: subject.deps.now,
    },
  )
  // A revisão independente passou a ser obrigatória: sem binário da família do Checker
  // (`codex`) a unidade estaciona depois do despacho do Maker, em vez de comitar.
  expect(exitCode).toBe(3)
  expect(subject.dispatched).toHaveBeenCalledTimes(1)
  expect(subject.dispatched).toHaveBeenCalledWith(expect.objectContaining({
    maxBudgetUsd: 25,
  }))
}, 20000)

test('CA2_ausencia_expiracao_ou_inconsistencia_bloqueia_antes_da_chamada', async () => {
  const { createLocalQuotaPort } = await import('../src/adapters/local/quota.ts')
  const repo = makeRepo()
  repos.push(repo.dir)

  const missingPort = createLocalQuotaPort({ receiptPath: path.join(repo.dir, 'missing-receipt.json') })
  await expect(missingPort.readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()

  const expiredPath = path.join(repo.dir, 'expired-receipt.json')
  fs.writeFileSync(expiredPath, JSON.stringify({
    ...RECEIPT,
    observed_at: '2026-09-18T00:00:00.000Z',
  }), 'utf8')
  const expiredPort = createLocalQuotaPort({ receiptPath: expiredPath })
  await expect(expiredPort.readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()

  const inconsistentPath = path.join(repo.dir, 'inconsistent-receipt.json')
  fs.writeFileSync(inconsistentPath, JSON.stringify({
    ...RECEIPT,
    family: 'codex',
  }), 'utf8')
  const inconsistentPort = createLocalQuotaPort({ receiptPath: inconsistentPath })
  await expect(inconsistentPort.readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()
})

test('CA3_reserva_e_duravel_e_nao_duplicada_na_retomada', async () => {
  const { runCommand } = await import('../src/cli/run.ts')
  const subject = fixture()
  const { planPath } = makePlanFixture(subject.repoDir)

  await subject.journal.append({
    kind: 'budget_reserved',
    unit: subject.story.id,
    data: {
      unit: subject.story.id,
      calls: 1,
      usd: 25,
      turns: 1,
      family: 'claude',
      phase: 'implementation',
      quota_receipt: RECEIPT,
    },
  })

  const readReceiptMock = vi.fn().mockResolvedValue(RECEIPT)
  const quotaPort = { readReceipt: readReceiptMock }

  const exitCode = await runCommand(
    { plan: planPath, repo: subject.repoDir, acceptStaleVersion: true },
    {
      env: { ADE_HOME: subject.repoDir, CI: 'true' } as any,
      quotaPort,
      dispatchClaude: subject.deps.dispatchClaude,
      now: subject.deps.now,
    },
  )

  // Idem CA1: o estacionamento por falta de Checker não pode duplicar a reserva já durável.
  expect(exitCode).toBe(3)
  expect(subject.dispatched).toHaveBeenCalledTimes(1)
  expect(readReceiptMock).not.toHaveBeenCalled()
  const events = readJournal(path.join(subject.missionDir, 'journal.jsonl')).events
  const reservations = events.filter((e) => e.kind === 'budget_reserved')
  expect(reservations).toHaveLength(1)
}, 20000)

test('CA4_limites_de_chamadas_turnos_e_contexto_sao_aplicados_onde_suportados_com_chamada_autorizada', async () => {
  const subject = fixture()
  let capturedAuth: any = null
  const originalDispatch = subject.dispatched
  subject.deps.dispatchClaude = vi.fn().mockImplementation(async (opts: any) => {
    capturedAuth = opts.authorization ?? opts.request?.authorization
    await originalDispatch(opts)
    return { status: 'ok' }
  })

  await run(subject)

  expect(subject.dispatched).toHaveBeenCalledTimes(1)
  expect(capturedAuth).toMatchObject({
    authorized: true,
    family: 'claude',
    phase: 'implementation',
    // A reserva mede as seções do contexto (o pack só é montado depois do worktree preparado).
    context_bytes: 418,
  })
})

test('CA4_contexto_que_excede_o_pack_bloqueia_antes_do_despacho', async () => {
  const subject = fixture({ packBytes: 120000 })
  await expect(run(subject)).resolves.toMatchObject({
    status: 'awaiting_operator', exitCode: 3, reason: 'context_limit_exceeded',
  })
  expect(subject.dispatched).not.toHaveBeenCalled()
})

test('CA5_relatorio_distingue_percentual_oficial_tokens_e_custo_sem_conversao_inventada', async () => {
  const { sumQuotaUsage, renderReport } = await import('../src/cli/report.ts')

  const events = [
    {
      kind: 'budget_reserved',
      at: '2026-09-20T00:00:00.000Z',
      data: {
        family: 'claude',
        quota_receipt: RECEIPT,
      },
    },
    {
      kind: 'telemetry',
      at: '2026-09-20T01:00:00.000Z',
      data: {
        family: 'claude',
        role: 'maker',
        tokens: { input: 1500, output: 500, cache_read: 0, usd: 0.03, source: 'reported' },
      },
    },
  ]

  const quota = sumQuotaUsage(events, NOW) as any
  expect(quota.governance_metrics).toEqual({
    has_official_receipt: true,
    fabricated_conversion: false,
    official_used_percent: 20,
    total_quota_tokens: 2000,
    total_cost_usd: 0.03,
  })

  const rendered = renderReport('m-quota', [], [{ role: 'maker', calls: 1, unavailable_calls: 0, input: 1500, cache_write: 0, cache_read: 0, output: 500, usd: 0.03 }], quota)
  expect(rendered).toContain('20%')
  expect(rendered).toContain('2000')
  expect(rendered).toContain('0.0300')
  expect(rendered).not.toMatch(/2000\s*tokens\s*=\s*\d+%/)
})

test('CA6_testes_usam_fontes_falsas_controladas_e_disponibilidade_real_e_verificada_separadamente', async () => {
  const quotaModule = await import('../src/adapters/local/quota.ts') as any
  expect(typeof quotaModule.verifyRealQuotaAvailability).toBe('function')

  const probeStub = vi.fn().mockResolvedValue({ reachable: true, verified_at: new Date(NOW).toISOString() })
  const check = await quotaModule.verifyRealQuotaAvailability({ family: 'claude', probe: probeStub })
  expect(check).toEqual({
    available: true,
    family: 'claude',
    source: 'official',
    probe_ok: true,
  })
  expect(probeStub).toHaveBeenCalledTimes(1)
})

test('CA7_sem_fonte_oficial_acessivel_registra_bloqueio_operacional', async () => {
  const subject = fixture({ receipt: null })
  const result = await run(subject)

  expect(result).toMatchObject({
    status: 'awaiting_operator',
    exitCode: 3,
    reason: 'quota_unavailable',
  })

  const events = readJournal(path.join(subject.missionDir, 'journal.jsonl')).events
  const blockEvent = events.find((e) => e.kind === 'operational_block')
  expect(blockEvent).toBeDefined()
  expect(blockEvent?.data).toMatchObject({
    reason: 'quota_unavailable',
    ready_for_autonomous_dispatch: false,
    fabricated_percent: null,
  })
})
