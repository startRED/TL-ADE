import { deriveStoryStates, isCompleted } from './schedule.ts'

export type EpicStoryState = {
  status: string
  commit: string | null
  reason: string | null
  rounds: number
  findings: unknown[]
}

export type DurableMissionState = {
  epicId: string | null
  storyStates: Record<string, EpicStoryState>
  pendingEpicSuite: string | null
  pendingPlanReview: boolean
}

type Epic = { id: string; stories: string[] }

/**
 * Épicos do plano em ordem, com id posicional `epic-<fase>-<épico>` (o schema do plano não dá id ao épico).
 * `phases` ausente vale como nenhum épico, como no `loadPlan`; presente fora de forma de lista falha fechado.
 */
export function epicsOf(plan: Record<string, any>): Epic[] {
  const phases = plan?.phases ?? []
  if (!Array.isArray(phases)) throw new TypeError('plano com phases inválidas')
  return phases.flatMap((phase: any, p: number) => {
    if (!Array.isArray(phase?.epics)) throw new TypeError(`fase ${p + 1} sem epics válidos`)
    return phase.epics.map((epic: any, e: number) => {
      if (!Array.isArray(epic?.stories)) throw new TypeError(`épico ${p + 1}-${e + 1} sem stories válidas`)
      return { id: `epic-${p + 1}-${e + 1}`, stories: [...epic.stories].map(String) }
    })
  })
}

function unitOf(ev: Record<string, any>): string | undefined {
  return ev.unit ?? ev.data?.unit
}

/** Épicos cuja suíte começou e ainda não terminou verde. */
function suitesOwed(events: Array<Record<string, any>>): Set<string> {
  const owed = new Set<string>()
  for (const ev of events) {
    const epic = ev?.data?.epic
    if (ev?.kind === 'epic_suite_started') owed.add(epic)
    if (ev?.kind === 'epic_suite_done' && ev.data?.ok === true) owed.delete(epic)
  }
  return owed
}

/**
 * Estado da missão derivado só do journal e do plano recarregado: tudo é id ou dado copiado, nunca
 * referência a objeto do plano. O estado das stories é o do épico corrente apenas, então rodadas e
 * achados de um épico anterior não aparecem no seguinte. Suíte de fim de épico iniciada sem fim verde e
 * revisão de plano pedida sem aprovação posterior continuam pendentes após reinício.
 */
export function deriveMissionState(events: Array<Record<string, any>>, plan: Record<string, any>): DurableMissionState {
  if (!Array.isArray(events)) throw new TypeError('deriveMissionState: events deve ser um array')
  const epics = epicsOf(plan)
  const states = deriveStoryStates(events)
  const owed = suitesOwed(events)
  const pendingEpicSuite = epics.find((e) => owed.has(e.id))?.id ?? null
  const current = pendingEpicSuite
    ? epics.find((e) => e.id === pendingEpicSuite)
    : epics.find((e) => !e.stories.every((id) => isCompleted(states[id])))

  const storyStates: Record<string, EpicStoryState> = {}
  for (const id of current?.stories ?? []) {
    const st = states[id]
    storyStates[id] = { status: st?.status ?? 'pending', commit: st?.commit ?? null, reason: st?.reason ?? null, rounds: 0, findings: [] }
  }

  let reviewRequestedAt = 0
  let approvedAt = 0
  for (const ev of events) {
    if (ev?.kind === 'plan_review_requested') reviewRequestedAt = ev.seq
    if (ev?.kind === 'decision' && ev.data?.decision === 'plan_approved') approvedAt = ev.seq
    const story = storyStates[unitOf(ev) ?? '']
    if (ev?.kind === 'review_result' && story) {
      story.rounds += 1
      story.findings = ev.data?.approved ? [] : structuredClone(ev.data?.errors ?? [])
    }
  }

  return {
    epicId: current?.id ?? null,
    storyStates,
    pendingEpicSuite,
    pendingPlanReview: reviewRequestedAt > approvedAt,
  }
}

/**
 * Épicos com todas as stories concluídas e sem suíte iniciada, derivados só do journal: morte entre o
 * último `story_done` e o marcador da suíte não perde a suíte, porque a retomada deriva de novo.
 */
export function epicSuitesToOpen(events: Array<Record<string, any>>, plan: Record<string, any>): string[] {
  const states = deriveStoryStates(events)
  const started = new Set(events.filter((ev) => ev?.kind === 'epic_suite_started').map((ev) => ev.data?.epic))
  return epicsOf(plan)
    .filter((e) => !started.has(e.id) && e.stories.every((id) => isCompleted(states[id])))
    .map((e) => e.id)
}
