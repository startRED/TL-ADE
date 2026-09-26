import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runStory } from '../src/engine.ts'
import { buildLadder, classifyMakerOutcome, correctionRequest, ladderStart, nextAttempt, reserveRung, retryRoundBonus } from '../src/engine/ladder.ts'
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

// 24/09, missão real (S2): o modelo foi cortado por turnos com o trabalho feito; a continuação terminou bem sem precisar
// mudar mais nada e o motor, comparando só com a tentativa cortada, estacionou em maker_no_change. A continuação de um
// corte compara com o começo da rodada.
test('continuacao_de_corte_que_termina_sem_mudar_mais_nada_segue', async () => {
  const subject = fixture([
    { result: { subtype: 'error_max_turns', num_turns: 30 }, changes: true },
    { result: { subtype: 'success', num_turns: 10 }, changes: false },
  ])
  const result = await subject.run()
  expect(subject.dispatched).toHaveBeenCalledTimes(2)
  expect(result.reason).not.toBe('maker_no_change')
})

// 24/09, missão real (S2): a correção esgotou com achados reais do revisor; "tentar de novo" reproduzia as mesmas
// decisões do journal e estacionava no mesmo ponto. Cada nova tentativa de parte parada por correção esgotada dá mais
// um lote de rodadas por degrau.
test('nova_tentativa_depois_de_correcao_esgotada_da_mais_rodadas', () => {
  const retry = (reason: string) => ({ kind: 'decision', unit: 'S2', data: { decision: 'unit_retry', unit: 'S2', previous_reason: reason } })
  expect(retryRoundBonus([], 'S2')).toBe(0)
  expect(retryRoundBonus([retry('rework_exhausted'), retry('base_diverged'), { kind: 'decision', data: { decision: 'unit_retry', unit: 'S1', previous_reason: 'rework_exhausted' } }], 'S2')).toBe(1)
  expect(retryRoundBonus([retry('unresolved_blocking_findings'), retry('maker_no_change')], 'S2')).toBe(2)
  // sem bônus a segunda reprovação já sobe de degrau; com um bônus ainda repete no mesmo
  const plain = nextAttempt(ladderStart(LADDER, 2), { kind: 'rejected' }).state
  expect(nextAttempt(plain, { kind: 'rejected' }).kind).not.toBe('repeat')
  const bonus = nextAttempt(ladderStart(LADDER, 2 * (1 + retryRoundBonus([retry('rework_exhausted')], 'S2'))), { kind: 'rejected' }).state
  expect(nextAttempt(bonus, { kind: 'rejected' }).kind).toBe('repeat')
})

// ADR 0046: cada rodada abria sessão nova e o maker relia tudo. A rodada seguinte no mesmo degrau retoma a sessão com o
// mesmo pack (o prompt de sistema igual mantém o cache) e só o que mudou no prompt; degrau novo ou 2 retomadas seguidas
// abrem sessão nova.
const SESSION = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`
const withPackPaths = (deps: any) => { deps.compilePack = (opts: any) => ({ pack_path: `pack-${opts.stepId}`, manifest_path: '', manifest: { bytes: 1 } }) }

test('retoma_a_sessao_do_maker_no_mesmo_degrau_e_abre_nova_ao_subir', async () => {
  const reply = (n: number) => ({ result: { subtype: 'success', num_turns: 5, session_ref: SESSION(n) }, changes: true })
  const subject = fixture([reply(1), reply(2), reply(3)], {
    makerLadder: [{ model: 'sonnet', family: 'claude' }, { model: 'opus', family: 'claude' }],
    maxModelCalls: 10,
  })
  withPackPaths(subject.deps)
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova'], ['tests/a.test.ts > nova'], null])
  await subject.run()
  const calls = subject.dispatched.mock.calls.map((call) => call[0])
  expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, SESSION(1), undefined])
  // o mesmo arquivo de pack da sessão, e o que mudou (a prova vermelha) no prompt
  expect(calls[1].packPath).toBe(calls[0].packPath)
  expect(calls[1].prompt).toContain('tests/a.test.ts > nova')
  expect(calls[2].model).toBe('opus')
  const resumed = subject.events().filter((e: any) => e.kind === 'decision' && e.data?.decision === 'maker_resume')
  expect(resumed.map((e: any) => e.data.session_ref)).toEqual([SESSION(1)])
  // o prompt da retomada fica gravado na pasta da missão, como o pack de uma sessão nova
  expect(fs.readFileSync(resumed[0].data.prompt_path, 'utf8')).toContain('tests/a.test.ts > nova')
}, 30000)

test('duas_retomadas_seguidas_abrem_sessao_nova_e_corte_pede_continuar', async () => {
  const reply = (n: number, subtype = 'success') => ({ result: { subtype, num_turns: 5, session_ref: SESSION(n) }, changes: true })
  const subject = fixture([reply(1, 'error_max_turns'), reply(2), reply(3), reply(4), reply(5)], {
    makerLadder: [{ model: 'sonnet', family: 'claude' }],
    maxModelCalls: 10,
  })
  withPackPaths(subject.deps)
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova']])
  // nova tentativa depois de correção esgotada: 4 rodadas no degrau, para caber a terceira chamada seguida nele
  await subject.deps.journal.append({ kind: 'decision', unit: 'ADE-L1', data: { decision: 'unit_retry', unit: 'ADE-L1', previous_reason: 'rework_exhausted' } })
  await subject.run()
  const calls = subject.dispatched.mock.calls.map((call) => call[0])
  expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, SESSION(1), SESSION(1), undefined, SESSION(4)])
  expect(calls[1].prompt).toMatch(/continue/i)
}, 30000)

test('sessao_sumida_cai_para_sessao_nova_e_registra', async () => {
  const subject = fixture([
    { result: { subtype: 'success', num_turns: 5, session_ref: SESSION(1) }, changes: true },
    { result: { exit_code: 1, is_error: false, session_ref: SESSION(1), session_missing: true }, changes: false },
    { result: { subtype: 'success', num_turns: 5, session_ref: SESSION(3) }, changes: true },
  ], { maxModelCalls: 10 })
  withPackPaths(subject.deps)
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova'], null])
  await subject.run()
  const calls = subject.dispatched.mock.calls.map((call) => call[0])
  expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, SESSION(1), undefined])
  // a sessão nova da mesma rodada leva o pack de correção, não o da sessão sumida
  expect(calls[2].packPath).not.toBe(calls[0].packPath)
  const fallback = subject.events().find((e: any) => e.kind === 'decision' && e.data?.decision === 'maker_resume_fallback')
  expect(fallback?.data).toMatchObject({ session_ref: SESSION(1), next: 'new_session' })
}, 30000)

test('codex_e_agy_ficam_com_sessao_nova', async () => {
  const reply = { result: { subtype: 'success', num_turns: 5, session_ref: SESSION(1) }, changes: true }
  const subject = fixture([reply, reply], { makerLadder: [{ model: 'gpt', family: 'codex' }], maxModelCalls: 10 })
  subject.deps.dispatchCodex = subject.dispatched
  subject.deps.checkerResolved = { exe: process.execPath, prefixArgs: [] }
  subject.deps.createGateRunner = redGate([['tests/a.test.ts > nova'], null])
  await subject.run()
  expect(subject.dispatched.mock.calls.map((call) => call[0].resumeSessionId)).toEqual([undefined, undefined])
}, 30000)
