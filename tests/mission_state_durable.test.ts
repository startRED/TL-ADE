import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { LoadedPlan } from '../src/engine/plan-load.ts'
import { deriveMissionState } from '../src/engine/mission-state.ts'
import { runSequentialMission } from '../src/engine/schedule.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const STAMP = '1:aaaaaaaa:bbbbbbbb'
let dirs: string[] = []
let journals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const j of journals) await j.close().catch(() => undefined)
  for (const d of dirs) removeTmpDir(d)
  journals = []
  dirs = []
})

/** Plano com dois épicos: epic-1-1 = [S1], epic-1-2 = [S2] (S2 depende de S1). */
function makeLoaded(): LoadedPlan {
  const contracts = [
    { id: 'S1', task: 'primeira parte', depends_on: [] },
    { id: 'S2', task: 'segunda parte', depends_on: ['S1'] },
  ]
  return {
    plan: {
      format_version: 2,
      id: 'P1',
      mission_id: 'm1',
      immutable_digest: '0000000000000000',
      authorization: { autonomy: 'safe', permitted_effects: [], eligible_skills: [] },
      phases: [{ epics: [{ stories: ['S1'] }, { stories: ['S2'] }] }],
      mission_budget: { max_usd: 10 },
      budget: { max_model_calls: 10, max_rework_rounds: 2 },
    },
    planDir: '',
    missionBudget: { max_usd: 10, max_wall_clock_seconds: 3600, max_parked_units: 1, max_subscription_weekly_percent: 50 },
    gates: [],
    stories: contracts.map((contract) => ({ id: contract.id, contract, spec_revision: 'r1', evals: [] })),
  }
}

/** Missão aprovada em pasta temporária, como o `ade approve` deixa no disco. */
async function setupMission() {
  const repoDir = makeTmpDir('ade-mstate-')
  dirs.push(repoDir)
  const missionDir = path.join(repoDir, '.ade', 'missions', 'm1')
  fs.mkdirSync(path.join(missionDir, 'stories'), { recursive: true })
  const loaded = makeLoaded()
  const contractDigests: Record<string, string> = {}
  for (const s of loaded.stories) {
    fs.writeFileSync(path.join(missionDir, 'stories', `${s.id}.json`), JSON.stringify(s.contract), 'utf8')
    contractDigests[s.id] = digest16(s.contract)
  }
  const journal = openJournal({ missionDir, runtimeStamp: STAMP })
  journals.push(journal)
  await journal.append({
    kind: 'decision',
    source: 'operator',
    data: {
      decision: 'plan_approved',
      digest: digest16(loaded.plan),
      summary_digest: digest16({ plan: digest16(loaded.plan), contracts: contractDigests }),
      contract_digests: contractDigests,
      eligible_skills: [],
      permitted_effects: [],
    },
  })
  return { repoDir, missionDir, journal, loaded }
}

/** Reinício simulado: fecha o journal do processo morto e reabre a partir do disco. */
async function restart(missionDir: string, dead: { close: () => Promise<void> }) {
  await dead.close()
  const journal = openJournal({ missionDir, runtimeStamp: STAMP })
  journals.push(journal)
  return journal
}

function readEvents(missionDir: string) {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

/** Dublê do step: registra a story recebida e grava o story_done no journal. */
function storyDouble(journal: { append: (e: Record<string, unknown>) => Promise<unknown> }, calls: Array<{ id: string; story: unknown }>) {
  return async (_deps: unknown, { story }: { story: { id: string } }) => {
    calls.push({ id: story.id, story })
    await journal.append({ kind: 'story_done', data: { unit: story.id, status: 'committed', commit: `c-${story.id}` } })
    return { status: 'committed', exitCode: 0, reason: null, commit: `c-${story.id}` }
  }
}

describe('estado da missão durável e por épico', () => {
  test('criterio_1_story_corrente_resolvida_pelo_id_no_plano_recarregado', async () => {
    const { repoDir, missionDir, journal } = await setupMission()
    await journal.append({ kind: 'story_done', data: { unit: 'S1', status: 'committed', commit: 'c-S1' } })

    const firstPlan = makeLoaded()
    const state = deriveMissionState(readEvents(missionDir), firstPlan.plan)
    // Só dados: nenhuma referência ao objeto do plano sobrevive no estado.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    firstPlan.plan.phases[0].epics[1].stories = ['S9']
    expect(state.epicId).toBe('epic-1-2')
    expect(Object.keys(state.storyStates)).toEqual(['S2'])

    // Reinício com o plano recarregado (objeto novo): a story despachada é a do plano novo.
    const j2 = await restart(missionDir, journal)
    const reloaded = makeLoaded()
    const calls: Array<{ id: string; story: unknown }> = []
    const result = await runSequentialMission(
      { journal: j2, runStory: storyDouble(j2, calls) },
      { loaded: reloaded, repoDir, missionDir },
    )
    expect(result.status).toBe('completed')
    expect(calls.map((c) => c.id)).toEqual(['S2'])
    expect(calls[0].story).toBe(reloaded.stories[1])
  })

  test('criterio_2_novo_epico_comeca_sem_contadores_rodadas_e_achados_do_anterior', async () => {
    const { missionDir, journal, loaded } = await setupMission()
    await journal.append({ kind: 'story_started', data: { unit: 'S1' } })
    await journal.append({ kind: 'review_result', data: { unit: 'S1', round: 1, approved: false, errors: ['achado grave X'] } })
    await journal.append({ kind: 'review_result', data: { unit: 'S1', round: 2, approved: false, errors: ['achado grave Y'] } })

    const during = deriveMissionState(readEvents(missionDir), loaded.plan)
    expect(during.epicId).toBe('epic-1-1')
    expect(during.storyStates).toEqual({ S1: { status: 'pending', commit: null, reason: null, rounds: 2, findings: ['achado grave Y'] } })

    await journal.append({ kind: 'story_done', data: { unit: 'S1', status: 'committed', commit: 'c-S1' } })
    const next = deriveMissionState(readEvents(missionDir), loaded.plan)
    expect(next.epicId).toBe('epic-1-2')
    expect(next.storyStates).toEqual({ S2: { status: 'pending', commit: null, reason: null, rounds: 0, findings: [] } })
    expect(JSON.stringify(next)).not.toContain('achado grave')
  })

  test('criterio_3_suite_de_fim_de_epico_pendente_roda_na_retomada_antes_do_proximo_epico', async () => {
    const { repoDir, missionDir, journal } = await setupMission()
    const order: string[] = []
    const calls: Array<{ id: string; story: unknown }> = []
    const killed = runSequentialMission(
      {
        journal,
        runStory: storyDouble(journal, calls),
        runEpicSuite: async ({ epicId }: { epicId: string }) => {
          order.push(`suite:${epicId}`)
          throw new Error('processo morto no meio da suíte')
        },
      },
      { loaded: makeLoaded(), repoDir, missionDir },
    )
    await expect(killed).rejects.toThrow('processo morto no meio da suíte')
    expect(calls.map((c) => c.id)).toEqual(['S1'])

    const j2 = await restart(missionDir, journal)
    const reloaded = makeLoaded()
    expect(deriveMissionState(readEvents(missionDir), reloaded.plan).pendingEpicSuite).toBe('epic-1-1')

    const result = await runSequentialMission(
      {
        journal: j2,
        runStory: async (deps: unknown, input: { story: { id: string } }) => {
          order.push(`story:${input.story.id}`)
          return storyDouble(j2, calls)(deps, input)
        },
        runEpicSuite: async ({ epicId }: { epicId: string }) => {
          order.push(`suite:${epicId}`)
          return { ok: true }
        },
      },
      { loaded: reloaded, repoDir, missionDir },
    )
    expect(result.status).toBe('completed')
    expect(order).toEqual(['suite:epic-1-1', 'suite:epic-1-1', 'story:S2', 'suite:epic-1-2'])
    expect(deriveMissionState(readEvents(missionDir), reloaded.plan).pendingEpicSuite).toBeNull()
  })

  test('criterio_3_borda_suite_vermelha_estaciona_e_segue_pendente', async () => {
    const { repoDir, missionDir, journal } = await setupMission()
    const calls: Array<{ id: string; story: unknown }> = []
    const result = await runSequentialMission(
      { journal, runStory: storyDouble(journal, calls), runEpicSuite: async () => ({ ok: false }) },
      { loaded: makeLoaded(), repoDir, missionDir },
    )
    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('epic_suite_red')
    expect(calls.map((c) => c.id)).toEqual(['S1'])
    expect(deriveMissionState(readEvents(missionDir), makeLoaded().plan).pendingEpicSuite).toBe('epic-1-1')
  })

  test('criterio_4_revisao_de_plano_pendente_sobrevive_ao_reinicio_e_nada_e_despachado', async () => {
    const { repoDir, missionDir, journal, loaded } = await setupMission()
    await journal.append({ kind: 'plan_review_requested', data: { reason: 'critério depende de dado do operador' } })

    const j2 = await restart(missionDir, journal)
    expect(deriveMissionState(readEvents(missionDir), loaded.plan).pendingPlanReview).toBe(true)
    const calls: Array<{ id: string; story: unknown }> = []
    const result = await runSequentialMission(
      { journal: j2, runStory: storyDouble(j2, calls) },
      { loaded: makeLoaded(), repoDir, missionDir },
    )
    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('plan_review_pending')
    expect(calls).toEqual([])

    // A aprovação posterior (fluxo de approve) encerra a revisão.
    await j2.append({ kind: 'decision', source: 'operator', data: { decision: 'plan_approved' } })
    expect(deriveMissionState(readEvents(missionDir), loaded.plan).pendingPlanReview).toBe(false)
  })

  test('borda_plano_sem_epicos_validos_falha_fechado', () => {
    expect(() => deriveMissionState([], { phases: 'x' })).toThrow(TypeError)
  })
})
