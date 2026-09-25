import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.ts'
import { roundsPerRung } from '../src/engine/ladder.ts'
import { storyRisk } from '../src/intent/risk.ts'
import { buildClaudeArgs } from '../src/adapters/claude/argv.ts'
import { buildCodexArgs } from '../src/adapters/codex/argv.ts'
import { dispatchCodex } from '../src/adapters/codex/index.ts'
import { dispatchAgyUnit } from '../src/adapters/agy/index.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

// segunda-feira de manhã: a semana renova no domingo à noite, 6,5 dias depois
const NOW = Date.parse('2026-09-21T00:00:00.000Z')
const RESETS = '2026-09-27T12:00:00.000Z'
const receipt = (family: string, used: number) => ({
  source: 'official', family, used_percent: used, reserved_percent: 0, observed_at: new Date(NOW).toISOString(), weekly_reset_at: RESETS,
})
const QUOTA_ERROR = { is_error: true, subtype: 'success', result_text: 'Claude AI usage limit reached|1789873200' }

const repos: string[] = []
const journals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  for (const repo of repos.splice(0)) removeRepo(repo)
})

type Call = { family: string; role: string; model: string; effort: string | undefined }

/**
 * Motor com dublês das três empresas. Quem escreve muda a árvore e leva 5 s no relógio injetado; quem revisa devolve
 * revisão vazia (a parte estaciona depois da revisão). A porta de cota devolve a leitura atual de `receipts`.
 */
function fixture(opts: { models?: Record<string, unknown>; receipts?: Record<string, any>; gates?: Array<string[] | null>; makerReplies?: any[]; makerLadder?: unknown[] } = {}) {
  const repo = makeRepo()
  repos.push(repo.dir)
  if (opts.models) {
    fs.mkdirSync(path.join(repo.dir, '.ade'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, '.ade', 'config.json'), JSON.stringify({ models: opts.models }), 'utf8')
  }
  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-route')
  fs.mkdirSync(missionDir, { recursive: true })
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  journals.push(journal)
  const clock = { now: NOW }
  const receipts: Record<string, any> = opts.receipts ?? { claude: receipt('claude', 1), codex: receipt('codex', 1), agy: receipt('agy', 1) }
  const replies = opts.makerReplies ?? []
  let tree = 0
  const calls: Call[] = []
  const dispatcher = (family: string) => vi.fn().mockImplementation(async (o: any) => {
    const role = o.role === 'checker_round' ? 'checker' : 'maker'
    calls.push({ family, role, model: o.model, effort: o.effort })
    if (role === 'checker') return { review_result: null }
    const reply = replies.shift() ?? { subtype: 'success', num_turns: 3 }
    clock.now += 5000
    if (!reply.is_error) tree++
    return reply
  })
  const gates = opts.gates ?? [null]
  const deps: any = {
    journal,
    quotaPort: { readReceipt: vi.fn().mockImplementation(async ({ family }: { family: string }) => receipts[family] ?? null) },
    step: async (spec: any, effect: any) => ({ step_id: spec.id, status: 'ok', result: await effect(), reused: false }),
    gitPortFor: () => ({ worktreeTree: async () => `tree${tree}`, dirtyPaths: async () => [] }),
    prepareStory: vi.fn().mockResolvedValue({ status: 'ready', worktreeDir: repo.dir }),
    createEvalRunner: () => ({ runEval: async () => ({ verdict: 'green' }) }),
    createGateRunner: () => ({
      runGates: async () => {
        const reds = gates.length > 1 ? gates.shift() : gates[0]
        if (!reds) return { ok: true, results: [] }
        return { ok: false, results: [{ gate_id: 'test', status: 'failure', exit_code: 1, argv: ['vitest'], raw_ref: 'r', reused: false, chargeable_reds: reds }] }
      },
    }),
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: { bytes: 1 } }),
    contain: async () => ({ ok: true, changedPaths: tree > 0 ? ['src/work.txt'] : [] }),
    plantCanary: async () => ({}),
    checkCanary: async () => ({ escaped: false }),
    dispatchClaude: dispatcher('claude'),
    dispatchCodex: dispatcher('codex'),
    dispatchAgy: dispatcher('agy'),
    resolved: { exe: process.execPath, prefixArgs: [] },
    workerEnv: {},
    capabilities: { probe_ok: true },
    env: { CI: 'true' },
    now: () => clock.now,
    sleep: vi.fn().mockImplementation(async (ms: number) => { clock.now += ms }),
    preflight: async () => ({ ready: true, failures: [], checks: [], calls_avoided: 0 }),
    makerLadder: opts.makerLadder,
  }
  const loaded = {
    plan: { id: 'plan-route', mission_id: 'mission-route', budget: { max_model_calls: 40 } },
    missionBudget: { max_usd: 300, max_model_calls: 40, max_wall_clock_seconds: 28800, max_parked_units: 3, max_subscription_weekly_percent: 100 },
    gates: [],
  }
  const storyOf = (id: string, contract: Record<string, unknown> = {}) => ({
    id,
    spec_revision: 'r1',
    evals: [],
    contract: {
      title: 'ajustar o texto do rodapé',
      roles: { maker: { family: 'claude', model_id: 'claude-opus-5-5' }, checker_round: { family: 'codex', model_id: 'gpt-6-astra' } },
      budget: { max_model_calls: 40, max_usd: 25 },
      guardrails: { scope_paths: [], do_not_touch: [] },
      ...contract,
    },
  })
  const run = (story = storyOf('ADE-R1')) => runStory(deps, { loaded: loaded as any, story: story as any, repoDir: repo.dir, missionDir })
  const events = () => readJournal(path.join(missionDir, 'journal.jsonl')).events as Array<Record<string, any>>
  const makers = () => calls.filter((c) => c.role === 'maker')
  const checkers = () => calls.filter((c) => c.role === 'checker')
  return { run, storyOf, events, calls, makers, checkers, receipts, deps, clock }
}

const PLANS = { claude: 'max20', codex: 'pro20' }

test('CA1_writer_is_head_of_code_chain_with_model_and_effort_per_cli_and_real_telemetry', async () => {
  const subject = fixture({ models: { plans: PLANS } })
  await subject.run()
  expect(subject.makers()[0]).toEqual({ family: 'codex', role: 'maker', model: 'gpt-6-astra', effort: 'medium' })
  const telemetry = subject.events().find((e) => e.kind === 'telemetry' && e.data?.role === 'maker')
  expect(telemetry?.data).toMatchObject({
    family: 'codex',
    effort: 'medium',
    models: [{ role: 'executor', model_id: 'gpt-6-astra' }],
    files_touched: 1,
    duration_ms: 5000,
  })

  // cada linha de comando recebe o esforço do seu jeito
  const claudeArgs = buildClaudeArgs({ sessionId: 's', packPath: 'p', maxBudgetUsd: 1, model: 'claude-opus-5-5', effort: 'high' })
  expect(claudeArgs.slice(claudeArgs.indexOf('--effort'), claudeArgs.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
  expect(buildCodexArgs({ role: 'maker', cwd: 'w', resultFile: 'r', model: 'gpt-6-astra', effort: 'high' })).toContain('model_reasoning_effort="high"')

  // Google leva o esforço no nome do modelo
  const google = fixture({ models: { plans: { agy: 'ultra1000' } } })
  await google.run()
  expect(google.makers()[0]).toMatchObject({ family: 'agy', model: 'gemini-3.8-flash-high' })
  const agyTelemetry = google.events().find((e) => e.kind === 'telemetry' && e.data?.role === 'maker')
  expect(agyTelemetry?.data).toMatchObject({ family: 'agy', effort: 'high', models: [{ model_id: 'gemini-3.8-flash-high' }] })
}, 30000)

test('CA2_quota_reading_between_parts_moves_writer_to_other_company_and_journals_model_chains_only_on_change', async () => {
  const subject = fixture({ models: { plans: PLANS, effort: { impl: 'high' } } })
  await subject.run(subject.storyOf('ADE-R1'))
  expect(subject.makers()[0]).toMatchObject({ family: 'claude', model: 'claude-opus-5-5' })
  expect(subject.events().filter((e) => e.kind === 'model_chains')).toHaveLength(1)

  // Claude a 95% num dia de semana: o código comum passa ao GPT-6 Astra (high) e o revisor ao Opus 5.5
  subject.receipts.claude = receipt('claude', 95)
  await subject.run(subject.storyOf('ADE-R2'))
  const second = subject.calls.filter((c) => c.role === 'maker').at(-1)
  expect(second).toMatchObject({ family: 'codex', model: 'gpt-6-astra', effort: 'high' })
  expect(subject.checkers().at(-1)).toMatchObject({ family: 'claude', model: 'claude-opus-5-5' })
  const chains = subject.events().filter((e) => e.kind === 'model_chains')
  expect(chains).toHaveLength(2)
  expect(chains[1].data.chains.writer[0]).toMatchObject({ family: 'codex', model: 'gpt-6-astra', effort: 'high' })
  expect(chains[1].data.why.writer.join(' ')).toContain('cota projetada')
  expect(chains[1].data.quota.claude).toMatchObject({ used: 95, source: 'official' })

  // leitura igual não muda a fila e não gera evento novo
  await subject.run(subject.storyOf('ADE-R3'))
  expect(subject.events().filter((e) => e.kind === 'model_chains')).toHaveLength(2)
}, 30000)

test('CA3_resume_after_quota_pause_rebuilds_chains_with_new_reading_before_next_dispatch', async () => {
  const subject = fixture({ models: { plans: PLANS, effort: { impl: 'high' } }, makerReplies: [QUOTA_ERROR] })
  subject.deps.sleep = vi.fn().mockImplementation(async (ms: number) => {
    subject.clock.now += ms
    subject.receipts.claude = { ...receipt('claude', 95), observed_at: new Date(subject.clock.now).toISOString() }
  })
  await subject.run()
  const [first, second] = subject.makers()
  expect(first).toMatchObject({ family: 'claude' })
  expect(second).toMatchObject({ family: 'codex', model: 'gpt-6-astra' })
  const kinds = subject.events().map((e) => e.kind)
  const resumed = kinds.indexOf('mission_resumed')
  expect(resumed).toBeGreaterThan(-1)
  expect(kinds.lastIndexOf('model_chains')).toBeGreaterThan(resumed)
}, 30000)

test('CA4_checker_is_always_from_other_company_than_the_round_writer_even_on_reserve_and_parks_without_one', async () => {
  // 2 rodadas reprovadas do ChatGPT e 2 do Claude, a 5ª (Claude) passa nos portões e vai à revisão
  const red = ['tests/a.test.ts > nova']
  const subject = fixture({ models: { plans: PLANS }, gates: [red, red, red, red, null] })
  await subject.run()
  expect(subject.makers().at(-1)).toMatchObject({ family: 'claude' })
  expect(subject.checkers()).toHaveLength(1)
  expect(subject.checkers()[0].family).toBe('codex')

  const first = fixture({ models: { plans: PLANS } })
  await first.run()
  expect(first.checkers()[0]).toMatchObject({ family: 'claude' })

  // só uma empresa: não há revisor possível
  const lonely = fixture({ models: { plans: { claude: 'max20' } } })
  const result = await lonely.run()
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'no_checker_family_available' })
  expect(lonely.checkers()).toHaveLength(0)
}, 60000)

test('CA5_ladder_rounds_per_rung_follow_risk_climb_in_intelligence_and_end_on_single_reserve', async () => {
  expect(storyRisk({ title: 'login com senha' })).toBe('sensitive')
  expect(roundsPerRung(storyRisk({ title: 'login com senha' }))).toBe(3)
  expect(storyRisk({ title: 'tela de pagamento' })).toBe('sensitive')
  expect(storyRisk({ title: 'migração de banco das faturas' })).toBe('sensitive')
  expect(storyRisk({ title: 'rodapé', risk: { level: 'normal', surfaces: ['security_boundary'], evidence: [] } })).toBe('sensitive')
  expect(storyRisk({ title: 'rodapé', risk: { level: 'light', surfaces: [], evidence: [] } })).toBe('light')
  expect(storyRisk({ title: 'rodapé' })).toBe('normal')
  expect([roundsPerRung('light'), roundsPerRung('normal')]).toEqual([1, 2])

  const tag = (c: Call) => `${c.family}:${c.model}(${c.effort})`
  const red = [['tests/a.test.ts > nova']]
  const normal = fixture({ models: { plans: PLANS }, gates: red })
  expect(await normal.run()).toMatchObject({ status: 'awaiting_operator', reason: 'gate_failed' })
  expect(normal.makers().map(tag)).toEqual([
    'codex:gpt-6-astra(medium)', 'codex:gpt-6-astra(medium)',
    'claude:claude-opus-5-5(high)', 'claude:claude-opus-5-5(high)',
    'claude:claude-opus-5-5(xhigh)', 'claude:claude-opus-5-5(xhigh)',
  ])

  const light = fixture({ models: { plans: PLANS }, gates: red })
  await light.run(light.storyOf('ADE-R1', { risk: { level: 'light', surfaces: [], evidence: [] } }))
  expect(light.makers().map(tag)).toEqual([
    'codex:gpt-6-astra(medium)', 'claude:claude-opus-5-5(high)', 'claude:claude-opus-5-5(xhigh)',
  ])

  const sensitive = fixture({ models: { plans: PLANS }, gates: red })
  await sensitive.run(sensitive.storyOf('ADE-R1', { title: 'login com senha' }))
  const calls = sensitive.makers().map(tag)
  expect(calls).toHaveLength(9)
  expect(calls.filter((c) => c.startsWith('codex:'))).toEqual(['codex:gpt-6-astra(medium)', 'codex:gpt-6-astra(medium)', 'codex:gpt-6-astra(medium)'])
  expect(calls.at(-1)).toBe('claude:claude-opus-5-5(xhigh)')
}, 90000)

test('C1.2: com planos Max 20x e Pro 20x e testes falhando, o motor sobe a escada de correção até esgotar os degraus sem nunca chegar ao máximo e termina na reserva de outra empresa', async () => {
  const tag = (c: Call) => `${c.family}:${c.model}(${c.effort})`
  const red = [['tests/a.test.ts > nova']]
  const subject = fixture({ models: { plans: PLANS }, gates: red })
  const result = await subject.run(subject.storyOf('ADE-R1', { risk: { level: 'light', surfaces: [], evidence: [] } }))
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'gate_failed' })
  const calls = subject.makers()
  expect(calls.some((c) => c.effort === 'max')).toBe(false)
  expect(calls.map(tag)).toEqual([
    'codex:gpt-6-astra(medium)', 'claude:claude-opus-5-5(high)', 'claude:claude-opus-5-5(xhigh)',
  ])
  expect(calls.at(-1)!.family).toBe('claude')
}, 60000)

test('CA6_blocked_model_is_never_dispatched_with_plans_and_part_parks_when_no_writer_is_left', async () => {
  const subject = fixture({ models: { plans: PLANS, blocked: ['claude-opus-5-5'] } })
  await subject.run()
  expect(subject.calls.length).toBeGreaterThan(0)
  expect(subject.calls.map((c) => c.model)).not.toContain('claude-opus-5-5')

  const none = fixture({ models: { plans: { claude: 'pro' }, blocked: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'] } })
  const result = await none.run()
  expect(result.status).toBe('awaiting_operator')
  expect(result.reason).toContain('bloqueado')
  expect(none.calls).toHaveLength(0)
}, 30000)

test('CA7_without_plans_blocked_contract_model_parks_before_dispatch_and_other_parts_run_as_before', async () => {
  const subject = fixture({ models: { blocked: ['gpt-6-astra'] } })
  const result = await subject.run()
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'modelo bloqueado pelo usuário: gpt-6-astra (checker)' })
  expect(subject.calls).toHaveLength(0)

  // degrau da escada com modelo bloqueado também estaciona antes de despachar
  const ladder = fixture({ models: { blocked: ['claude-fable-5-1'] }, makerLadder: [{ model: 'claude-opus-5-5', family: 'claude' }, { model: 'claude-fable-5-1', family: 'claude' }] })
  expect(await ladder.run()).toMatchObject({ reason: 'modelo bloqueado pelo usuário: claude-fable-5-1 (fix)' })
  expect(ladder.calls).toHaveLength(0)

  const free = fixture({ models: { blocked: ['gpt-6-sol'] } })
  await free.run()
  expect(free.makers()[0]).toMatchObject({ family: 'claude', model: 'claude-opus-5-5' })
}, 30000)

test('CA8_chains_changing_mid_mission_keep_approved_plan_and_mission_does_not_wait_for_approval', async () => {
  const subject = fixture({ models: { plans: PLANS, effort: { impl: 'high' } } })
  const story = subject.storyOf('ADE-R2')
  const frozen = JSON.stringify(story)
  await subject.run(subject.storyOf('ADE-R1'))
  subject.receipts.claude = receipt('claude', 95)
  await subject.run(story)
  expect(JSON.stringify(story)).toBe(frozen)
  expect(subject.makers().at(-1)).toMatchObject({ family: 'codex' })
  const kinds = subject.events().map((e) => e.kind)
  expect(kinds.filter((k) => /approval/.test(k))).toEqual([])
  expect(subject.events().filter((e) => e.kind === 'story_done').map((e) => e.data.reason)).not.toContain('approval_required')
}, 30000)

test('CA9_without_plans_or_blocks_engine_uses_contract_roles_as_before', async () => {
  const subject = fixture()
  await subject.run()
  expect(subject.makers()).toEqual([{ family: 'claude', role: 'maker', model: 'claude-opus-5-5', effort: undefined }])
  expect(subject.checkers()[0]).toMatchObject({ family: 'codex', model: 'gpt-6-astra' })
  expect(subject.events().some((e) => e.kind === 'model_chains')).toBe(false)
  expect(subject.deps.quotaPort.readReceipt.mock.calls.map(([p]: any[]) => p.family)).toEqual(['claude'])
}, 30000)

test('CA4_without_plans_writer_of_same_company_as_contract_checker_parks_before_review', async () => {
  // a reserva da escada (ou quem chama) pode ser da empresa do revisor fixo do contrato: sem revisor independente, estaciona
  const subject = fixture({ makerLadder: [{ model: 'gpt-6-astra', family: 'codex' }] })
  expect(await subject.run()).toMatchObject({ status: 'awaiting_operator', reason: 'no_checker_family_available' })
  expect(subject.makers()).toHaveLength(1)
  expect(subject.checkers()).toHaveLength(0)
}, 30000)

test('CA1_google_rung_uses_its_own_binary_and_default_dispatcher', async () => {
  // sem dublê do Google, o motor usa o despacho real do agy; sem o binário do agy resolvido, estaciona sem rodar o do Claude
  const subject = fixture({ makerLadder: [{ model: 'gemini-3.8-flash', family: 'agy', effort: 'high' }] })
  delete subject.deps.dispatchAgy
  subject.deps.agyResolved = null
  expect(await subject.run()).toMatchObject({ status: 'awaiting_operator', reason: 'writer_dispatch_unavailable' })
  expect(subject.calls).toHaveLength(0)
}, 30000)

test('CA1_codex_and_google_adapters_dispatch_the_writer_role', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-route-'))
  const packPath = path.join(dir, 'pack.md')
  fs.writeFileSync(packPath, 'tarefa')
  const argvs: string[][] = []
  const runWorkerImpl = vi.fn().mockImplementation(async ({ args }: { args: string[] }) => {
    argvs.push(args)
    return { exitCode: 0, stdout: '{"response":"feito"}', stderr: '' }
  })
  const step = async (_spec: any, fn: () => Promise<unknown>) => ({ step_id: 's', status: 'ok', result: await fn() })
  const common = { step, unit: 'u', stepId: 'u:r1:maker', packPath, missionDir: dir, missionId: 'm', cwd: dir, resultFile: path.join(dir, 'r.json'), resolved: { exe: 'x', prefixArgs: [] }, role: 'maker', runWorkerImpl }
  try {
    const agy = await dispatchAgyUnit({ ...common, model: 'gemini-3.8-flash-high' })
    expect(agy).toMatchObject({ is_error: false, result_text: 'feito', review_result: null })
    expect(argvs[0]).not.toContain('plan')
    expect(argvs[0].join(' ')).toContain('--model gemini-3.8-flash-high')
    await dispatchAgyUnit({ ...common, role: 'checker_round' })
    expect(argvs[1].join(' ')).toContain('--mode plan')
    // quem escreve pelo Google recebe o schema de resultado de unidade e devolve o resultado validado
    expect(JSON.parse(argvs[0][argvs[0].indexOf('--json-schema') + 1]).required).toContain('tree_after')
    const unit = JSON.parse(fs.readFileSync(new URL('../fixtures/schemas/unit-result/valid.json', import.meta.url), 'utf8'))
    runWorkerImpl.mockImplementationOnce(async () => ({ exitCode: 0, stdout: JSON.stringify({ response: '', structured_output: unit }), stderr: '' }))
    expect(await dispatchAgyUnit({ ...common, model: 'gemini-3.8-flash-high' })).toMatchObject({ unit_result: unit, valid: true, review_result: null })

    const codex = await dispatchCodex({ ...common, model: 'gpt-6-astra', effort: 'high' })
    expect(codex).toMatchObject({ is_error: false, review_result: null })
    expect(argvs[2]).toContain('workspace-write')
    expect(argvs[2]).toContain('model_reasoning_effort="high"')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
