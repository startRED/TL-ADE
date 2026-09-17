/**
 * @typedef {{
 *   step_id: string,
 *   effect_class: string,
 *   input_digest: string,
 *   runtime_stamp: string,
 *   intent_seq: number | null,
 *   result_seq: number | null,
 *   status: string | null,
 * }} StepState
 */

/**
 * @typedef {{
 *   seq: number,
 *   step_id: string,
 *   effect_class: string,
 *   input_digest: string,
 *   runtime_stamp: string,
 * }} OpenIntent
 */

/**
 * @typedef {{
 *   seq: number,
 *   source: string | null,
 *   data: Record<string, unknown>,
 * }} DecisionState
 */

/**
 * @typedef {{
 *   lastSeq: number,
 *   kinds: Record<string, number>,
 *   steps: Record<string, StepState>,
 *   openIntents: Array<OpenIntent>,
 *   decisions: Array<DecisionState>,
 * }} MissionState
 */

/**
 * Coleta e consolida os passos a partir dos eventos do diário.
 * @param {ReadonlyArray<Record<string, unknown>>} events
 * @returns {Map<string, StepState>}
 */
function collectSteps(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('fold: events deve ser um array')
  }

  /** @type {Map<string, StepState>} */
  const map = new Map()

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
 * @param {ReadonlyArray<Record<string, unknown>>} events
 * @returns {Array<OpenIntent>}
 */
export function openIntents(events) {
  const stepMap = collectSteps(events)
  /** @type {Array<OpenIntent>} */
  const list = []

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
 * @param {ReadonlyArray<Record<string, unknown>>} events
 * @returns {MissionState}
 */
export function fold(events) {
  const stepMap = collectSteps(events)

  let lastSeq = 0
  if (events.length > 0) {
    const lastEvent = events[events.length - 1]
    if (lastEvent && typeof lastEvent.seq === 'number') {
      lastSeq = lastEvent.seq
    }
  }

  /** @type {Record<string, number>} */
  const kinds = {}
  /** @type {Array<DecisionState>} */
  const decisions = []

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
          ? /** @type {Record<string, unknown>} */ ({ ...ev.data })
          : {}
      decisions.push({ seq, source, data })
    }
  }

  /** @type {Record<string, StepState>} */
  const steps = Object.fromEntries(stepMap)

  return {
    lastSeq,
    kinds,
    steps,
    openIntents: openIntents(events),
    decisions,
  }
}
