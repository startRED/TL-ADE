import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.ts'
import { authorizePaidCall } from '../src/engine/budget.ts'
import { classifyCallFailure } from '../src/engine/quota.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'

const NOW = Date.parse('2026-09-20T00:00:00.000Z')
// A CLI do Claude devolve a renovação em segundos Unix depois do `|`.
const RESET_ISO = '2026-09-20T03:00:00.000Z'
const QUOTA_ERROR = { is_error: true, subtype: 'success', result_text: 'Claude AI usage limit reached|1789873200' }
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

// Adaptador dublê: devolve as respostas na ordem; relógio injetado que só anda no sleep.
function fixture(responses: any[], options: { missionDir?: string; repoDir?: string; sleep?: (ms: number) => Promise<void> } = {}) {
  let repoDir = options.repoDir
  if (!repoDir) {
    const repo = makeRepo()
    repos.push(repo.dir)
    repoDir = repo.dir
  }
  const missionDir = options.missionDir ?? path.join(repoDir, '.ade', 'missions', 'mission-quota')
  fs.mkdirSync(missionDir, { recursive: true })
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  journals.push(journal)
  const clock = { now: NOW }
  const dispatchedAt: number[] = []
  const dispatched = vi.fn().mockImplementation(async (opts: any) => {
    dispatchedAt.push(clock.now)
    const response = responses.shift() ?? {}
    if (!response.is_error && opts?.cwd) {
      fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true })
      fs.writeFileSync(path.join(opts.cwd, 'src', 'work.txt'), 'ok\n', 'utf8')
    }
    return response
  })
  const sleep = vi.fn().mockImplementation(options.sleep ?? (async (ms: number) => { clock.now += ms }))
  const story = {
    id: 'ADE-Q1',
    spec_revision: 'r1',
    evals: [],
    contract: {
      roles: { maker: { family: 'claude' } },
      budget: { max_model_calls: 2, max_usd: 25 },
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
    quotaPort: { readReceipt: vi.fn().mockResolvedValue(RECEIPT) },
    step: async (spec: any, effect: any) => ({ step_id: spec.id, status: 'ok', result: await effect(), reused: false }),
    // árvore limpa: a retomada depois do reinício não tem trabalho interrompido para guardar
    gitPortFor: () => ({ worktreeTree: async () => 'tree', dirtyPaths: async () => [] }),
    prepareStory: vi.fn().mockResolvedValue({ status: 'ready', worktreeDir: repoDir }),
    createEvalRunner: () => ({ runEval: async () => ({ verdict: 'red_valid' }) }),
    createGateRunner: () => ({ runGates: async () => ({ ok: true, results: [] }) }),
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: { bytes: 1 } }),
    contain: async () => ({ ok: false, reason: 'stop_after_dispatch' }),
    plantCanary: async () => ({}),
    checkCanary: async () => ({ escaped: false }),
    dispatchClaude: dispatched,
    resolved: { exe: process.execPath, prefixArgs: [] },
    workerEnv: {},
    capabilities: { probe_ok: true },
    env: { CI: 'true' },
    now: () => clock.now,
    sleep,
    preflight: async () => ({ ready: true, failures: [], checks: [], calls_avoided: 0 }),
  }
  const run = () => runStory(deps, { loaded: loaded as any, story, repoDir: repoDir as string, missionDir })
  const events = () => readJournal(path.join(missionDir, 'journal.jsonl')).events
  return { clock, deps, dispatched, dispatchedAt, events, journal, missionDir, repoDir, run, sleep }
}

test('ca1_quota_error_pauses_mission_with_reset_time_and_spends_no_round', async () => {
  const subject = fixture([QUOTA_ERROR, {}])
  await subject.run()
  const events = subject.events()
  const paused = events.filter((event) => event.kind === 'mission_paused')
  expect(paused).toHaveLength(1)
  expect(paused[0].data).toMatchObject({ reason: 'quota', resume_at: RESET_ISO })
  // a escada não anda: nenhuma decisão, mesmo degrau e mesmo teto de turnos, e a rodada continua a 1
  expect(events.some((event) => event.kind === 'decision' && event.data?.decision === 'maker_ladder')).toBe(false)
  const [first, second] = subject.dispatched.mock.calls.map(([opts]: any[]) => opts)
  expect(second.model).toBe(first.model)
  expect(second.maxTurns).toBe(first.maxTurns)
  expect(first.stepId).toBe('ADE-Q1:r1:maker')
  expect(second.stepId).toBe('ADE-Q1:r1t1:maker')
})

test('ca2_paused_mission_resumes_by_itself_when_injected_clock_passes_reset', async () => {
  const subject = fixture([QUOTA_ERROR, {}])
  const result = await subject.run()
  const events = subject.events()
  const pausedAt = events.findIndex((event) => event.kind === 'mission_paused')
  const resumedAt = events.findIndex((event) => event.kind === 'mission_resumed')
  expect(pausedAt).toBeGreaterThanOrEqual(0)
  expect(resumedAt).toBeGreaterThan(pausedAt)
  expect(events[resumedAt].data).toMatchObject({ reason: 'quota', resume_at: RESET_ISO })
  // sem aprovação nova nem parada entre a pausa e a retomada
  expect(events.slice(pausedAt, resumedAt).some((event) => event.kind === 'story_done' || /approv/.test(String(event.kind)))).toBe(false)
  expect(subject.sleep).toHaveBeenCalled()
  expect(subject.dispatched).toHaveBeenCalledTimes(2)
  expect(subject.dispatchedAt[1]).toBeGreaterThanOrEqual(Date.parse(RESET_ISO))
  // a retomada seguiu até o próximo desfecho do maker (a contenção dublê para aqui)
  expect(result).toMatchObject({ reason: 'stop_after_dispatch' })
})

test('ca3_conversation_text_or_max_turns_is_never_quota', () => {
  expect(classifyCallFailure({ is_error: false, subtype: 'success', result_text: 'Implementei a pausa quando o limite de uso (usage limit reached) chega.' }).kind).toBe('other')
  expect(classifyCallFailure({ is_error: true, subtype: 'error_max_turns', result_text: 'Claude AI usage limit reached|1789873200' }).kind).toBe('max_turns')
  expect(classifyCallFailure(QUOTA_ERROR)).toEqual({ kind: 'quota', resetAt: RESET_ISO })
  // borda: erro de cota sem hora legível ainda é cota, sem hora inventada pelo classificador
  expect(classifyCallFailure({ is_error: true, result_text: "You've hit your limit" })).toEqual({ kind: 'quota' })
  expect(classifyCallFailure({ is_error: true, result_text: 'EACCES: permissão negada' }).kind).toBe('env_blocked')
})

test('ca3_max_turns_from_engine_does_not_pause_mission', async () => {
  const subject = fixture([{ is_error: true, subtype: 'error_max_turns', result_text: 'rate limit do texto' }, {}])
  await subject.run()
  expect(subject.events().some((event) => event.kind === 'mission_paused')).toBe(false)
  expect(subject.sleep).not.toHaveBeenCalled()
})

test('ca4_spend_above_300_usd_is_not_blocked_and_is_recorded', async () => {
  expect(authorizePaidCall({ observed_usd: 320, open_reservations: [], requested_usd: 1 })).toMatchObject({
    allowed: true,
    reason: null,
    usd_total: 321,
  })

  const subject = fixture([{}])
  await subject.journal.append({ kind: 'step_result', unit: 'old', step_id: 'old:r1:maker', data: { cost_usd: 320 } })
  await subject.run()
  expect(subject.dispatched).toHaveBeenCalledTimes(1)
  const reserved = subject.events().find((event) => event.kind === 'budget_reserved')
  expect(reserved?.data).toMatchObject({ usd: 25, usd_total: 345 })
})

test('ca5_restart_before_reset_keeps_mission_paused_with_same_time', async () => {
  const died = new Error('processo morreu')
  const first = fixture([QUOTA_ERROR], { sleep: async () => { throw died } })
  await expect(first.run()).rejects.toBe(died)
  await first.journal.close()
  journals.splice(journals.indexOf(first.journal), 1)

  // segundo processo, uma hora depois, antes da renovação; a CLI diria outra hora se fosse chamada
  const second = fixture([{ ...QUOTA_ERROR, result_text: 'Claude AI usage limit reached|1789880400' }], {
    missionDir: first.missionDir,
    repoDir: first.repoDir,
    sleep: async () => { throw died },
  })
  second.clock.now = NOW + 60 * 60 * 1000
  await expect(second.run()).rejects.toBe(died)
  expect(second.dispatched).not.toHaveBeenCalled()
  expect(second.sleep).toHaveBeenCalledWith(Date.parse(RESET_ISO) - second.clock.now)
  const events = second.events()
  expect(events.filter((event) => event.kind === 'mission_paused').map((event) => event.data?.resume_at)).toEqual([RESET_ISO])
  expect(events.some((event) => event.kind === 'mission_resumed')).toBe(false)
})
