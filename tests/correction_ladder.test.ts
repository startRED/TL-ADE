import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.ts'
import { buildLadder, classifyMakerOutcome, correctionRequest, ladderStart, nextAttempt, reserveRung } from '../src/engine/ladder.ts'
import { deriveStoryStates, isCompleted } from '../src/engine/schedule.ts'
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

const LADDER = buildLadder([
  { model: 'sonnet', family: 'claude' },
  { model: 'opus', family: 'claude', maxTurns: 36 },
  { model: 'gpt', family: 'codex', reserve: true },
])

/** Maker dublê: cada item da fila diz o que a chamada devolve e se muda a árvore. */
function fixture(replies: Array<{ result: Record<string, unknown>; changes: boolean }>, opts: { makerLadder?: unknown[]; maxModelCalls?: number } = {}) {
  const repo = makeRepo()
  repos.push(repo.dir)
  const missionDir = path.join(repo.dir, '.ade', 'missions', 'mission-ladder')
  fs.mkdirSync(missionDir, { recursive: true })
  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  journals.push(journal)
  let tree = 0
  const dispatched = vi.fn().mockImplementation(async () => {
    const reply = replies.shift()
    if (!reply) throw new Error('maker chamado além do roteiro')
    if (reply.changes) tree++
    return reply.result
  })
  const story = {
    id: 'ADE-L1',
    spec_revision: 'r1',
    evals: [],
    contract: {
      roles: { maker: { family: 'claude', model_id: 'sonnet' } },
      budget: { max_model_calls: 4, max_usd: 25 },
      guardrails: { scope_paths: [], do_not_touch: [] },
    },
  }
  const loaded = {
    plan: { id: 'plan-ladder', mission_id: 'mission-ladder', budget: { max_model_calls: 4 } },
    missionBudget: { max_usd: 300, max_model_calls: opts.maxModelCalls ?? 4, max_wall_clock_seconds: 28800, max_parked_units: 3 },
    gates: [],
  }
  const deps: any = {
    journal,
    quotaPort: { readReceipt: vi.fn().mockResolvedValue(RECEIPT) },
    step: async (spec: any, effect: any) => ({ step_id: spec.id, status: 'ok', result: await effect(), reused: false }),
    gitPortFor: () => ({ worktreeTree: async () => `tree${tree}` }),
    prepareStory: vi.fn().mockResolvedValue({ status: 'ready', worktreeDir: repo.dir }),
    createEvalRunner: () => ({ runEval: async () => ({ verdict: 'green' }) }),
    createGateRunner: () => ({ runGates: async () => ({ ok: true, results: [] }) }),
    compilePack: () => ({ pack_path: '', manifest_path: '', manifest: { bytes: 1 } }),
    contain: async () => ({ ok: true, changedPaths: tree > 0 ? ['src/work.txt'] : [] }),
    plantCanary: async () => ({}),
    checkCanary: async () => ({ escaped: false }),
    dispatchClaude: dispatched,
    resolved: { exe: process.execPath, prefixArgs: [] },
    workerEnv: {},
    capabilities: { probe_ok: true },
    env: { CI: 'true' },
    now: () => NOW,
    preflight: async () => ({ ready: true, failures: [], checks: [], calls_avoided: 0 }),
    makerLadder: opts.makerLadder,
  }
  const run = () => runStory(deps, { loaded: loaded as any, story, repoDir: repo.dir, missionDir })
  const events = () => readJournal(path.join(missionDir, 'journal.jsonl')).events
  return { run, dispatched, events, deps }
}

test('CA1_maker_cut_at_max_turns_repeats_same_rung_with_more_turns_without_counting_round', async () => {
  const state = ladderStart(LADDER)
  const outcome = classifyMakerOutcome({ subtype: 'error_max_turns', changed: true, resultText: '' })
  expect(outcome).toEqual({ kind: 'max_turns' })
  // terminar com sucesso bem no teto não é corte
  expect(classifyMakerOutcome({ subtype: 'success', changed: true, resultText: '' })).toEqual({ kind: 'ok' })
  const next = nextAttempt(state, outcome)
  expect(next).toMatchObject({ kind: 'repeat', countsAsRound: false })
  expect(next.maxTurns).toBeGreaterThan(state.maxTurns)
  expect(next.state.rung).toBe(0)
  expect(next.state.rounds).toBe(0)

  // Caminho real: o motor repete a chamada com mais turnos na mesma rodada, com passo próprio.
  const subject = fixture([
    { result: { subtype: 'error_max_turns', num_turns: 30 }, changes: true },
    { result: { subtype: 'success', num_turns: 12 }, changes: true },
  ])
  await subject.run()
  expect(subject.dispatched).toHaveBeenCalledTimes(2)
  const [first, second] = subject.dispatched.mock.calls.map((call) => call[0])
  expect(first.maxTurns).toBe(30)
  expect(second.maxTurns).toBe(60)
  expect(second.stepId).not.toBe(first.stepId)
  expect(second.stepId).not.toContain(':r2:')
})

test('CA1_second_cut_at_extended_turns_counts_as_round', () => {
  const extended = nextAttempt(ladderStart(LADDER), { kind: 'max_turns' }).state
  const again = nextAttempt(extended, { kind: 'max_turns' })
  expect(again.countsAsRound).toBe(true)
  expect(again.state.rounds).toBe(1)
})

test('CA2_climbing_a_rung_never_lowers_max_turns', () => {
  const ladder = buildLadder([
    { model: 'a', family: 'claude', maxTurns: 40 },
    { model: 'b', family: 'claude', maxTurns: 20 },
    { model: 'c', family: 'codex', reserve: true },
  ])
  expect(ladder.map((rung) => rung.maxTurns)).toEqual([40, 40, 40])
  let state = ladderStart(ladder)
  let previous = state.maxTurns
  for (const kind of ['rejected', 'rejected', 'rejected', 'rejected'] as const) {
    const next = nextAttempt(state, { kind })
    expect(next.maxTurns).toBeGreaterThanOrEqual(previous)
    previous = next.maxTurns
    state = next.state
  }
  expect(() => buildLadder([])).toThrow()
  expect(() => buildLadder([{ model: 'a', family: 'claude', reserve: true }, { model: 'b', family: 'claude' }])).toThrow()
})

test('CA3_no_change_or_env_blocked_moves_to_next_model_without_spending_round', async () => {
  const state = ladderStart(LADDER)
  expect(classifyMakerOutcome({ subtype: 'success', changed: false, resultText: 'feito' })).toEqual({ kind: 'no_change' })
  expect(classifyMakerOutcome({ subtype: 'success', changed: false, resultText: 'sandbox somente leitura: EPERM' })).toEqual({ kind: 'env_blocked' })
  expect(classifyMakerOutcome({ subtype: 'success', changed: true, resultText: 'EPERM' })).toEqual({ kind: 'ok' })
  for (const kind of ['no_change', 'env_blocked'] as const) {
    const next = nextAttempt(state, { kind })
    expect(next).toMatchObject({ kind: 'next_model', countsAsRound: false })
    expect(next.state.rung).toBe(1)
    expect(next.state.rounds).toBe(0)
  }

  // Caminho real com um só modelo no contrato: não há próximo modelo, a parte estaciona sem revisão.
  const subject = fixture([{ result: { subtype: 'success', num_turns: 4 }, changes: false }])
  const result = await subject.run()
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'maker_no_change' })
  expect(subject.dispatched).toHaveBeenCalledTimes(1)

  // Com escada de dois modelos, a chamada sem mudança passa ao próximo sem abrir rodada.
  const two = fixture([
    { result: { subtype: 'success', num_turns: 4 }, changes: false },
    { result: { subtype: 'success', num_turns: 4 }, changes: true },
  ], { makerLadder: [{ model: 'sonnet', family: 'claude' }, { model: 'opus', family: 'claude' }] })
  await two.run()
  const [firstCall, secondCall] = two.dispatched.mock.calls.map((call) => call[0])
  expect(firstCall.model).toBe('sonnet')
  expect(secondCall.model).toBe('opus')
  expect(secondCall.stepId).not.toContain(':r2:')
  expect(two.events().some((event) => event.kind === 'budget_reserved' && (event.data as any)?.unit === 'ADE-L1:rung1')).toBe(true)
}, 30000)

test('CA4_two_rejected_rounds_climb_then_reserve_once_then_park', () => {
  let state = ladderStart(LADDER)
  const kinds: string[] = []
  for (let i = 0; i < 5; i++) {
    const next = nextAttempt(state, { kind: 'rejected' })
    kinds.push(next.kind)
    expect(next.countsAsRound).toBe(true)
    state = next.state
  }
  expect(kinds).toEqual(['repeat', 'climb', 'repeat', 'reserve', 'park'])
})

test('CA4_ladder_without_reserve_parks_when_exhausted', () => {
  let state = ladderStart(buildLadder([{ model: 'sonnet', family: 'claude' }]))
  state = nextAttempt(state, { kind: 'rejected' }).state
  expect(nextAttempt(state, { kind: 'rejected' }).kind).toBe('park')
  expect(() => nextAttempt(state, { kind: 'ok' })).toThrow()
  expect(() => nextAttempt(state, { kind: 'bogus' } as any)).toThrow()
})

test('CA5_failed_correction_round_parks_without_new_correction_and_original_done_only_by_own_approval', () => {
  // a rodada de correção é a própria escada: reprovada no fim dela, estaciona sem abrir outra
  let state = ladderStart(buildLadder([{ model: 'sonnet', family: 'claude' }]))
  state = nextAttempt(state, { kind: 'rejected' }).state
  expect(nextAttempt(state, { kind: 'rejected' }).kind).toBe('park')

  const approvedFix = [{ kind: 'story_done', unit: 'S1:rung1', data: { status: 'committed', commit: 'c1' } }]
  expect(isCompleted(deriveStoryStates(approvedFix).S1)).toBe(false)
  const own = [...approvedFix, { kind: 'story_done', unit: 'S1', data: { status: 'committed', commit: 'c2' } }]
  expect(isCompleted(deriveStoryStates(own).S1)).toBe(true)
})

test('CA6_correction_request_carries_chargeable_reds_and_open_grave_findings', () => {
  const request = correctionRequest({
    redTests: ['tests/a.test.ts > nova', 'tests/b.test.ts > antiga'],
    preexistingReds: ['tests/b.test.ts > antiga'],
    findings: [
      { severity: 'high', problem: 'grave' },
      { severity: 'low', problem: 'estilo' },
      { severity: 'critical', problem: 'já resolvido', state: 'resolved' },
    ],
  })
  expect(request.red_tests).toEqual(['tests/a.test.ts > nova'])
  expect(request.findings.map((f) => f.problem)).toEqual(['grave'])
})

test('CA7_model_switch_uses_call_reservation_and_denied_reservation_parks', () => {
  const full = [
    { kind: 'budget_reserved', unit: 'S1' },
    { kind: 'budget_reserved', unit: 'S2' },
  ]
  expect(reserveRung({ events: full, storyId: 'S1', rung: 1, maxModelCalls: 2 })).toBe('denied')
  expect(reserveRung({ events: full.slice(0, 1), storyId: 'S1', rung: 1, maxModelCalls: 2 })).toBe('reserved')
  // reserva já feita para o mesmo degrau não reserva de novo nem estaciona
  expect(reserveRung({ events: [...full, { kind: 'budget_reserved', unit: 'S1:rung1' }], storyId: 'S1', rung: 1, maxModelCalls: 2 })).toBe('already_reserved')
})

test('CA7_engine_parks_when_model_switch_reservation_is_denied', async () => {
  const subject = fixture([{ result: { subtype: 'success', num_turns: 4 }, changes: false }], {
    makerLadder: [{ model: 'sonnet', family: 'claude' }, { model: 'opus', family: 'claude' }],
    maxModelCalls: 1,
  })
  const result = await subject.run()
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'ladder_reserve_denied' })
  expect(subject.dispatched).toHaveBeenCalledTimes(1)
})

test('CA7_engine_journals_ladder_decision_for_cut_maker', async () => {
  const subject = fixture([
    { result: { subtype: 'error_max_turns', num_turns: 30 }, changes: false },
    { result: { subtype: 'success', num_turns: 9 }, changes: true },
  ])
  await subject.run()
  const decision = subject.events().find((event) => event.kind === 'decision' && (event.data as any)?.decision === 'maker_ladder')
  expect(decision?.data).toMatchObject({ outcome: 'max_turns', next: 'repeat', max_turns: 60, counts_as_round: false })
})

test('CA2_turns_granted_by_a_cut_never_drop_on_model_switch_or_climb', () => {
  // corte eleva 30 → 60; o próximo degrau declara 36 e não pode devolver o teto a 36
  const cut = nextAttempt(ladderStart(LADDER), { kind: 'max_turns' })
  const moved = nextAttempt(cut.state, { kind: 'no_change' })
  expect(moved).toMatchObject({ kind: 'next_model', maxTurns: 60 })
  // no degrau novo, o corte ainda repete com mais turnos sem contar rodada
  expect(nextAttempt(moved.state, { kind: 'max_turns' })).toMatchObject({ kind: 'repeat', maxTurns: 120, countsAsRound: false })

  let state = cut.state
  state = nextAttempt(state, { kind: 'rejected' }).state
  expect(state.maxTurns).toBe(60)
  expect(nextAttempt(state, { kind: 'rejected' })).toMatchObject({ kind: 'climb', maxTurns: 60 })
})

/** Portão dublê: cada chamada devolve o próximo resultado da fila; o último se repete. */
function redGate(runs: Array<string[] | null>) {
  return () => ({
    runGates: async () => {
      const reds = runs.length > 1 ? runs.shift() : runs[0]
      if (!reds) return { ok: true, results: [] }
      return { ok: false, results: [{ gate_id: 'test', status: 'failure', exit_code: 1, argv: ['vitest'], raw_ref: 'r', reused: false, chargeable_reds: reds }] }
    },
  })
}

test('CA4_engine_red_rounds_use_two_rounds_per_rung_without_global_rework_cap', async () => {
  const changed = { result: { subtype: 'success', num_turns: 5 }, changes: true }
  const subject = fixture([changed, changed, changed, changed], {
    makerLadder: [{ model: 'sonnet', family: 'claude' }, { model: 'opus', family: 'claude' }],
    maxModelCalls: 10,
  })
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova']])
  const result = await subject.run()
  // antes o teto de retrabalho do contrato (2) estacionava na 1ª rejeição do degrau de cima
  expect(subject.dispatched.mock.calls.map((call) => call[0].model)).toEqual(['sonnet', 'sonnet', 'opus', 'opus'])
  expect(result).toMatchObject({ status: 'awaiting_operator', reason: 'gate_failed' })
}, 30000)

test('CA6_engine_correction_round_carries_chargeable_reds_and_open_findings', async () => {
  const changed = { result: { subtype: 'success', num_turns: 5 }, changes: true }
  const subject = fixture([changed, changed])
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova'], null])
  const packs: any[] = []
  subject.deps.compilePack = (opts: any) => {
    packs.push(opts)
    return { pack_path: '', manifest_path: '', manifest: { bytes: 1 } }
  }
  await subject.run()
  expect(subject.dispatched).toHaveBeenCalledTimes(2)
  const rework = packs.find((pack) => pack.sections?.policy === 'rework')
  const correction = JSON.parse(rework.sections.story).correction
  expect(correction.red_tests).toEqual(['tests/a.test.ts > nova'])
  expect(correction.handoff.open_findings).toEqual([])
}, 30000)
