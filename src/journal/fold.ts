export type StepState = {
  step_id: string,
  effect_class: string,
  input_digest: string,
  runtime_stamp: string,
  intent_seq: number | null,
  result_seq: number | null,
  status: string | null,
}

export type OpenIntent = {
  seq: number,
  step_id: string,
  effect_class: string,
  input_digest: string,
  runtime_stamp: string,
}

export type DecisionState = {
  seq: number,
  source: string | null,
  data: Record<string, unknown>,
}

export type MissionState = {
  lastSeq: number,
  kinds: Record<string, number>,
  steps: Record<string, StepState>,
  openIntents: Array<OpenIntent>,
  decisions: Array<DecisionState>,
}

/**
 * Coleta e consolida os passos a partir dos eventos do diário.
 */
function collectSteps(events: ReadonlyArray<Record<string,unknown>>): Map<string,StepState> {
  if (!Array.isArray(events)) {
    throw new TypeError('fold: events deve ser um array')
  }

  const map: Map<string,StepState> = new Map()

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') {
      continue
    }

    if (ev.kind === 'step_intent' && typeof ev.step_id === 'string') {
      const stepId = ev.step_id
      map.set(stepId, {
        step_id: stepId,
        effect_class: String(ev.effect_class),
        input_digest: String(ev.input_digest),
        runtime_stamp: String(ev.runtime_stamp),
        intent_seq: Number(ev.seq),
        result_seq: null,
        status: null,
      })
    } else if (ev.kind === 'step_result' && typeof ev.step_id === 'string') {
      const stepId = ev.step_id
      const existing = map.get(stepId)
      const status = typeof ev.status === 'string' ? ev.status : null
      if (existing && existing.result_seq === null) {
        map.set(stepId, {
          ...existing,
          result_seq: Number(ev.seq),
          status,
        })
      } else {
        map.set(stepId, {
          step_id: stepId,
          effect_class: String(ev.effect_class),
          input_digest: String(ev.input_digest),
          runtime_stamp: String(ev.runtime_stamp),
          intent_seq: null,
          result_seq: Number(ev.seq),
          status,
        })
      }
    }
  }

  return map
}

/**
 * Lista intenções de passos ainda não concluídas ordenadas por sequência.
 */
export function openIntents(events: ReadonlyArray<Record<string,unknown>>): Array<OpenIntent> {
  const stepMap = collectSteps(events)
  const list: Array<OpenIntent> = []

  for (const step of stepMap.values()) {
    if (step.intent_seq !== null && step.result_seq === null) {
      list.push({
        seq: step.intent_seq,
        step_id: step.step_id,
        effect_class: step.effect_class,
        input_digest: step.input_digest,
        runtime_stamp: step.runtime_stamp,
      })
    }
  }

  list.sort((a, b) => a.seq - b.seq)
  return list
}

/**
 * Dobra a lista de eventos do diário no estado consolidado da missão.
 */
export function fold(events: ReadonlyArray<Record<string,unknown>>): MissionState {
  const stepMap = collectSteps(events)

  let lastSeq = 0
  if (events.length > 0) {
    const lastEvent = events[events.length - 1]
    if (lastEvent && typeof lastEvent.seq === 'number') {
      lastSeq = lastEvent.seq
    }
  }

  const kinds: Record<string,number> = {}
  const decisions: Array<DecisionState> = []

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') {
      continue
    }

    if (typeof ev.kind === 'string') {
      kinds[ev.kind] = (kinds[ev.kind] || 0) + 1
    }

    if (ev.kind === 'decision') {
      const seq = typeof ev.seq === 'number' ? ev.seq : 0
      const source = typeof ev.source === 'string' ? ev.source : null
      const data =
        ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data)
          ? ({ ...ev.data } as Record<string, unknown>)
          : {}
      decisions.push({ seq, source, data })
    }
  }

  const steps: Record<string,StepState> = Object.fromEntries(stepMap)

  return {
    lastSeq,
    kinds,
    steps,
    openIntents: openIntents(events),
    decisions,
  }
}
