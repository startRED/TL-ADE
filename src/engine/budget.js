// @ts-check
import { AdeError } from '../journal/errors.js'

/**
 * Valida se o orçamento de chamadas de modelo é um inteiro >= 1.
 *
 * @param {{ max_model_calls?: any }} budget
 * @param {'plan' | 'contract'} where
 * @returns {void}
 */
export function assertCallBudget(budget, where) {
  if (!budget || !Number.isInteger(budget.max_model_calls) || budget.max_model_calls < 1) {
    throw new AdeError(
      'zero_model_call_budget',
      `orçamento de chamadas zerado em ${where}`,
      4,
    )
  }
}

/**
 * Soma o custo em USD observado para chamadas de modelo (:maker) e conta chamadas não-observadas.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {{ observed_usd: number, unobserved_calls: number }}
 */
export function observedUsd(events) {
  let observed_usd = 0
  let unobserved_calls = 0

  if (Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      if (event.kind !== 'step_result') continue

      const stepId = event.step_id ?? event.data?.step_id
      if (typeof stepId === 'string' && stepId.endsWith(':maker')) {
        const costUsd =
          event.data?.result?.usage?.cost_usd ?? event.result?.usage?.cost_usd
        if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
          observed_usd += costUsd
        } else {
          unobserved_calls += 1
        }
      }
    }
  }

  return { observed_usd, unobserved_calls }
}

/**
 * Compara o custo observado com o teto de USD.
 *
 * @param {{ observed_usd: number, max_usd: number }} params
 * @returns {{
 *   ok: boolean,
 *   reason: 'budget_usd_exceeded' | null,
 *   observed_usd: number,
 *   max_usd: number,
 * }}
 */
export function checkUsdCap({ observed_usd, max_usd }) {
  const ok = observed_usd <= max_usd
  return {
    ok,
    reason: ok ? null : 'budget_usd_exceeded',
    observed_usd,
    max_usd,
  }
}

/**
 * Determina se deve reservar uma chamada de modelo para a story ou se já foi reservada/paga/esgotada.
 * Ordem:
 * (1) Existe step_result com step_id `${storyId}:r1:maker` -> { reserve: 0, reason: 'already_paid' }
 * (2) Existe evento kind 'budget_reserved' com unit === storyId -> { reserve: 0, reason: 'already_reserved' }
 * (3) A contagem de eventos 'budget_reserved' no escopo global é >= maxModelCalls -> { reserve: 0, reason: 'exhausted' }
 * (4) Senão -> { reserve: 1, reason: 'reserved' }
 *
 * @param {{
 *   events: Array<Record<string, any>>,
 *   storyId: string,
 *   maxModelCalls: number,
 * }} params
 * @returns {{
 *   reserve: 0 | 1,
 *   reason: 'reserved' | 'already_reserved' | 'already_paid' | 'exhausted',
 * }}
 */
export function reserveCalls({ events, storyId, maxModelCalls }) {
  const evts = Array.isArray(events) ? events : []

  const makerStepId = `${storyId}:r1:maker`
  const hasMakerResult = evts.some(
    (e) =>
      e &&
      e.kind === 'step_result' &&
      (e.step_id === makerStepId || e.data?.step_id === makerStepId),
  )
  if (hasMakerResult) {
    return { reserve: 0, reason: 'already_paid' }
  }

  const hasReserved = evts.some(
    (e) =>
      e &&
      e.kind === 'budget_reserved' &&
      (e.unit === storyId || e.data?.unit === storyId),
  )
  if (hasReserved) {
    return { reserve: 0, reason: 'already_reserved' }
  }

  const reservedCount = evts.filter(
    (e) => e && e.kind === 'budget_reserved',
  ).length
  if (reservedCount >= maxModelCalls) {
    return { reserve: 0, reason: 'exhausted' }
  }

  return { reserve: 1, reason: 'reserved' }
}

/**
 * Verifica os orçamentos determinísticos da missão:
 * - Quantidade de chamadas de modelo dos events
 * - Tempo decorrido de relógio (wall clock) desde o primeiro evento até now
 * - Quantidade de states awaiting_operator
 *
 * Devolve:
 * { allowed: false, reason: 'model_call_budget_exhausted' | 'wall_clock_exhausted' | 'max_parked_units' }
 * ou
 * { allowed: true, reason: null }
 *
 * @param {Object} [params]
 * @param {Array<Record<string, any>>} [params.events]
 * @param {Record<string, any>} [params.budget]
 * @param {number} [params.now]
 * @param {Record<string, any> | Array<any>} [params.states]
 * @returns {{
 *   allowed: boolean,
 *   reason: 'model_call_budget_exhausted' | 'wall_clock_exhausted' | 'max_parked_units' | null,
 * }}
 */
export function checkMissionBudget({ events = [], budget = {}, now = Date.now(), states = {} } = {}) {
  const evts = Array.isArray(events) ? events : []

  // 1. Model calls dos events (correlacionando reserva e resultado da mesma story para não duplicar contagem)
  if (budget.max_model_calls !== undefined && budget.max_model_calls !== null) {
    /** @type {Map<string, { reserved: number, executedStepIds: Set<string>, otherExecuted: number }>} */
    const unitStats = new Map()
    let anonymousCalls = 0

    for (const event of evts) {
      if (!event || typeof event !== 'object') continue

      const isReserved = event.kind === 'budget_reserved'
      const isMakerResult =
        event.kind === 'step_result' &&
        ((typeof event.step_id === 'string' && event.step_id.endsWith(':maker')) ||
          (typeof event.data?.step_id === 'string' && event.data.step_id.endsWith(':maker')) ||
          event.effect_class === 'model_call' ||
          event.data?.effect_class === 'model_call')
      const isDirectModelCall =
        event.kind === 'model_call' ||
        (event.effect_class === 'model_call' && event.kind !== 'step_intent' && event.kind !== 'step_result') ||
        (event.data?.effect_class === 'model_call' && event.kind !== 'step_intent' && event.kind !== 'step_result')

      if (!isReserved && !isMakerResult && !isDirectModelCall) {
        continue
      }

      // Identifica a unidade/story do evento
      let unit =
        (typeof event.unit === 'string' && event.unit) ||
        (typeof event.data?.unit === 'string' && event.data.unit) ||
        (typeof event.story_id === 'string' && event.story_id) ||
        (typeof event.data?.story_id === 'string' && event.data.story_id) ||
        null

      const stepId = event.step_id ?? event.data?.step_id
      if (!unit && typeof stepId === 'string') {
        const colonIdx = stepId.indexOf(':')
        if (colonIdx > 0) {
          unit = stepId.substring(0, colonIdx)
        }
      }

      if (!unit) {
        anonymousCalls++
        continue
      }

      if (!unitStats.has(unit)) {
        unitStats.set(unit, { reserved: 0, executedStepIds: new Set(), otherExecuted: 0 })
      }
      const stats = /** @type {{ reserved: number, executedStepIds: Set<string>, otherExecuted: number }} */ (
        unitStats.get(unit)
      )

      if (isReserved) {
        const calls = typeof event.data?.calls === 'number' ? event.data.calls : 1
        stats.reserved += calls
      } else if (typeof stepId === 'string' && stepId) {
        stats.executedStepIds.add(stepId)
      } else {
        stats.otherExecuted++
      }
    }

    let callCount = anonymousCalls
    for (const stats of unitStats.values()) {
      const executed = stats.executedStepIds.size + stats.otherExecuted
      callCount += Math.max(stats.reserved, executed)
    }

    if (callCount >= budget.max_model_calls) {
      return { allowed: false, reason: 'model_call_budget_exhausted' }
    }
  }

  // 2. Wall clock desde o primeiro event até now
  const maxWallClockMs =
    budget.max_wall_clock_ms ??
    (budget.max_wall_clock_seconds !== undefined ? budget.max_wall_clock_seconds * 1000 : undefined)

  if (maxWallClockMs !== undefined && maxWallClockMs !== null) {
    let firstAt = null
    for (const event of evts) {
      if (!event || typeof event !== 'object') continue
      const rawAt = event.at ?? event.ts ?? event.timestamp ?? event.time
      if (rawAt !== undefined && rawAt !== null) {
        const atVal = typeof rawAt === 'number' ? rawAt : new Date(rawAt).getTime()
        if (Number.isFinite(atVal)) {
          if (firstAt === null || atVal < firstAt) {
            firstAt = atVal
          }
        }
      }
    }

    if (firstAt !== null) {
      const nowVal = typeof now === 'number' ? now : new Date(now).getTime()
      const elapsed = nowVal - firstAt
      if (elapsed >= maxWallClockMs) {
        return { allowed: false, reason: 'wall_clock_exhausted' }
      }
    }
  }

  // 3. Quantidade de states awaiting_operator
  if (budget.max_parked_units !== undefined && budget.max_parked_units !== null) {
    const statesList = Array.isArray(states)
      ? states
      : typeof states === 'object' && states !== null
        ? Object.values(states)
        : []

    let parkedCount = 0
    for (const s of statesList) {
      if (
        s === 'awaiting_operator' ||
        s?.status === 'awaiting_operator' ||
        s?.state === 'awaiting_operator' ||
        s?.outcome === 'awaiting_operator' ||
        s?.outcome === 'parked' ||
        s === 'parked'
      ) {
        parkedCount++
      }
    }

    if (parkedCount >= budget.max_parked_units) {
      return { allowed: false, reason: 'max_parked_units' }
    }
  }

  return { allowed: true, reason: null }
}

