import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.js'
import { AdeError } from '../src/journal/errors.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { makeRepo, removeRepo } from './helpers/git-repo.js'

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

function fixture(options: { receipt?: any; maxUsd?: number; quotaPort?: any } = {}) {
  const repo = makeRepo()
  repos.push(repo.dir)
  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-quota')
  fs.mkdirSync(missionDir, { recursive: true })
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  journals.push(journal)
  const sequence: string[] = []
  const dispatched = vi.fn().mockImplementation(async () => {
    sequence.push('dispatch')
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
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: {} }),
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
  const { createLocalQuotaPort } = await import('../src/adapters/local/quota.js')
  await expect(createLocalQuotaPort().readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()

  const subject = fixture()
  const receiptPath = path.join(subject.repoDir, 'quota-receipt.json')
  fs.writeFileSync(receiptPath, JSON.stringify(RECEIPT), 'utf8')
  await expect(createLocalQuotaPort({ receiptPath }).readReceipt({ family: 'claude', now: NOW })).resolves.toEqual(RECEIPT)

  fs.writeFileSync(receiptPath, '{', 'utf8')
  await expect(createLocalQuotaPort({ receiptPath }).readReceipt({ family: 'claude', now: NOW })).resolves.toBeNull()
})
