// @ts-check
import { AdeError } from '../journal/errors.js'

export const ABSOLUTE_USD_CAP = 300

export const PHASE_TURN_LIMITS = {
  proof: 14,
  implementation: 30,
  correction: 20,
  review: 10,
}

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
      // Se stepId for informado e não terminar em :maker e não for model_call, ignora (ex: contain)
      if (
        typeof stepId === 'string' &&
        !stepId.endsWith(':maker') &&
        event.effect_class !== 'model_call' &&
        event.data?.effect_class !== 'model_call'
      ) {
        continue
      }

      const costUsd =
        event.data?.cost_usd !== undefined
          ? event.data.cost_usd
          : event.cost_usd !== undefined
            ? event.cost_usd
            : event.data?.result?.usage?.cost_usd !== undefined
              ? event.data.result.usage.cost_usd
              : event.result?.usage?.cost_usd

      if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
        observed_usd += costUsd
      } else {
        unobserved_calls += 1
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
    (budget.max_wall_clock_seconds !== undefined
      ? budget.max_wall_clock_seconds * 1000
      : undefined)

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

/**
 * Extrai a unit/story_id associada a um evento.
 *
 * @param {Record<string, any>} event
 * @returns {string | null}
 */
function getEventUnit(event) {
  if (!event || typeof event !== 'object') return null
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
  return unit
}

/**
 * Retorna as reservas abertas: eventos budget_reserved sem step_result de maker
 * nem story_done para a mesma unit.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {Array<Record<string, any>>}
 */
export function getOpenReservations(events) {
  if (!Array.isArray(events)) return []

  const closedUnits = new Set()

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const unit = getEventUnit(event)
    if (!unit) continue

    const isMakerResult =
      event.kind === 'step_result' &&
      ((typeof event.step_id === 'string' && event.step_id.endsWith(':maker')) ||
        (typeof event.data?.step_id === 'string' && event.data.step_id.endsWith(':maker')) ||
        event.effect_class === 'model_call' ||
        event.data?.effect_class === 'model_call')

    const isStoryDone = event.kind === 'story_done' || event.kind === 'unit_done'

    if (isMakerResult || isStoryDone) {
      closedUnits.add(unit)
    }
  }

  const openReservations = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.kind !== 'budget_reserved') continue

    const unit = getEventUnit(event)
    if (unit && !closedUnits.has(unit)) {
      openReservations.push(event)
    }
  }

  return openReservations
}

/**
 * Valida o recibo de cota oficial de uma família.
 *
 * @param {any} receipt
 * @param {Object} [options]
 * @param {string} [options.family]
 * @param {number} [options.max_percent]
 * @param {number | string | Date} [options.now]
 * @returns {{
 *   ok: boolean,
 *   reason: 'quota_unavailable' | 'quota_untrusted' | 'quota_exhausted' | null,
 *   used_percent: number | null,
 *   reserved_percent: number | null,
 * }}
 */
export function validateQuotaReceipt(receipt, { family, max_percent = 50, now = Date.now() } = {}) {
  if (!receipt || typeof receipt !== 'object') {
    return {
      ok: false,
      reason: 'quota_unavailable',
      used_percent: null,
      reserved_percent: null,
    }
  }

  if (receipt.source !== 'official') {
    return {
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    }
  }

  if (
    family &&
    (typeof receipt.family !== 'string' ||
      receipt.family.trim().length === 0 ||
      receipt.family !== family)
  ) {
    return {
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    }
  }

  const used = receipt.used_percent
  const reserved = receipt.reserved_percent
  if (
    used === null ||
    used === undefined ||
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    reserved === null ||
    reserved === undefined ||
    typeof reserved !== 'number' ||
    !Number.isFinite(reserved) ||
    used < 0 ||
    reserved < 0
  ) {
    return {
      ok: false,
      reason: 'quota_untrusted',
      used_percent: null,
      reserved_percent: null,
    }
  }

  if (!receipt.observed_at || !receipt.weekly_reset_at) {
    return {
      ok: false,
      reason: 'quota_unavailable',
      used_percent: used,
      reserved_percent: reserved,
    }
  }

  const obsTime = new Date(receipt.observed_at).getTime()
  const resetTime = new Date(receipt.weekly_reset_at).getTime()
  if (!Number.isFinite(obsTime) || !Number.isFinite(resetTime)) {
    return {
      ok: false,
      reason: 'quota_unavailable',
      used_percent: used,
      reserved_percent: reserved,
    }
  }

  const nowTime = typeof now === 'number' ? now : new Date(now).getTime()
  if (nowTime - obsTime > 86400000 || nowTime > resetTime) {
    return {
      ok: false,
      reason: 'quota_unavailable',
      used_percent: used,
      reserved_percent: reserved,
    }
  }

  const cap = typeof max_percent === 'number' ? max_percent : 50
  if (used + reserved >= cap) {
    return {
      ok: false,
      reason: 'quota_exhausted',
      used_percent: used,
      reserved_percent: reserved,
    }
  }

  return {
    ok: true,
    reason: null,
    used_percent: used,
    reserved_percent: reserved,
  }
}

/**
 * Autoriza uma chamada paga após checar tetos absolutos, reservas abertas, limites de missão,
 * turnos, contexto e cota por família.
 *
 * @param {Object} [params]
 * @param {Array<Record<string, any>>} [params.events]
 * @param {Record<string, any>} [params.mission_budget]
 * @param {Record<string, any>} [params.story_budget]
 * @param {string} [params.family]
 * @param {string} [params.phase]
 * @param {number} [params.requested_usd]
 * @param {number} [params.requested_calls]
 * @param {number} [params.requested_turns]
 * @param {number} [params.used_turns]
 * @param {number} [params.context_bytes]
 * @param {number} [params.context_limit]
 * @param {any} [params.quota_receipt]
 * @param {number | string | Date} [params.now]
 * @param {Record<string, any> | Array<any>} [params.states]
 * @param {number} [params.observed_usd]
 * @param {Array<any>} [params.open_reservations]
 * @returns {{
 *   allowed: boolean,
 *   reason: string | null,
 *   reservation: { calls: number, usd: number, turns: number, family: string } | null,
 * }}
 */
export function authorizePaidCall(params = {}) {
  const {
    events = [],
    mission_budget,
    story_budget,
    family,
    phase,
    requested_usd = 0,
    requested_calls = 1,
    requested_turns = 1,
    context_bytes,
    context_limit,
    quota_receipt,
    now = Date.now(),
    states = {},
  } = params

  // 1. Validações de sanidade / CA5: valores negativos ou não finitos
  if (typeof requested_usd !== 'number' || !Number.isFinite(requested_usd) || requested_usd < 0) {
    throw new AdeError('invalid_budget_reservation', 'requested_usd inválido', 4)
  }
  if (typeof requested_calls !== 'number' || !Number.isFinite(requested_calls) || requested_calls < 0) {
    throw new AdeError('invalid_budget_reservation', 'requested_calls inválido', 4)
  }
  if (typeof requested_turns !== 'number' || !Number.isFinite(requested_turns) || requested_turns < 0) {
    throw new AdeError('invalid_budget_reservation', 'requested_turns inválido', 4)
  }
  if (context_bytes !== undefined && (typeof context_bytes !== 'number' || !Number.isFinite(context_bytes) || context_bytes < 0)) {
    throw new AdeError('invalid_budget_reservation', 'context_bytes inválido', 4)
  }
  if (context_limit !== undefined && (typeof context_limit !== 'number' || !Number.isFinite(context_limit) || context_limit < 0)) {
    throw new AdeError('invalid_budget_reservation', 'context_limit inválido', 4)
  }

  if (mission_budget?.max_usd !== undefined) {
    const maxUsd = mission_budget.max_usd
    if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd > ABSOLUTE_USD_CAP || maxUsd < 0) {
      throw new AdeError(
        'budget_usd_above_absolute_cap',
        `orçamento max_usd (${maxUsd}) inválido ou acima do teto absoluto de US$ 300`,
        4,
        { max_usd: maxUsd },
      )
    }
  }

  const nowMs = typeof now === 'number' ? now : new Date(now).getTime()

  // 2. Validação de cota por família se family informada ou se quota_receipt informado
  if (family !== undefined || quota_receipt !== undefined) {
    const quotaCheck = validateQuotaReceipt(quota_receipt, {
      family,
      max_percent: 50,
      now: nowMs,
    })
    if (!quotaCheck.ok) {
      return {
        allowed: false,
        reason: quotaCheck.reason,
        reservation: null,
      }
    }
  }

  // 3. Teto de USD: observed_usd + reservas abertas + requested_usd
  let obsUsd = 0
  if (typeof params.observed_usd === 'number') {
    obsUsd = params.observed_usd
  } else if (Array.isArray(events)) {
    obsUsd = observedUsd(events).observed_usd
  }

  let openResUsd = 0
  if (Array.isArray(params.open_reservations)) {
    for (const r of params.open_reservations) {
      const usd =
        typeof r === 'number'
          ? r
          : r && typeof r === 'object'
            ? (r.data?.usd ?? r.usd ?? 0)
            : NaN
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
        throw new AdeError('invalid_budget_reservation', 'reserva usd inválida', 4)
      }
      openResUsd += usd
    }
  } else if (Array.isArray(events)) {
    const openRes = getOpenReservations(events)
    for (const r of openRes) {
      const usd = r.data?.usd ?? r.usd ?? 0
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
        throw new AdeError('invalid_budget_reservation', 'reserva usd inválida', 4)
      }
      openResUsd += usd
    }
  }

  const totalUsd = obsUsd + openResUsd + requested_usd

  // Teto absoluto de US$ 300
  if (totalUsd >= ABSOLUTE_USD_CAP) {
    return {
      allowed: false,
      reason: 'absolute_usd_cap',
      reservation: null,
    }
  }

  // Teto do mission_budget.max_usd se configurado
  if (mission_budget?.max_usd !== undefined && mission_budget?.max_usd !== null) {
    if (totalUsd >= mission_budget.max_usd) {
      return {
        allowed: false,
        reason: 'budget_usd_exceeded',
        reservation: null,
      }
    }
  }

  // 4. Limites determinísticos da missão (model calls, wall clock, parked units)
  if (mission_budget || story_budget || Array.isArray(events) || states) {
    const maxModelCalls = [mission_budget?.max_model_calls, story_budget?.max_model_calls]
      .filter((value) => value !== undefined && value !== null)
      .reduce((minimum, value) => Math.min(minimum, value), Infinity)
    const applicableBudget = {
      ...mission_budget,
      ...(Number.isFinite(maxModelCalls) ? { max_model_calls: maxModelCalls } : {}),
    }
    const eventsWithRequest = [
      ...events,
      {
        kind: 'budget_reserved',
        unit: '__pending_paid_call__',
        data: { calls: requested_calls },
      },
    ]
    const missionCheck = checkMissionBudget({
      events: eventsWithRequest,
      budget: applicableBudget,
      now: nowMs,
      states,
    })
    if (!missionCheck.allowed) {
      return {
        allowed: false,
        reason: missionCheck.reason,
        reservation: null,
      }
    }
  }

  // 5. Limite de turnos por fase
  if (phase) {
    /** @type {Record<string, number>} */
    const turnLimits = PHASE_TURN_LIMITS
    const phaseLimit = turnLimits[phase] ?? Infinity
    let usedTurns = 0
    if (typeof params.used_turns === 'number') {
      usedTurns = params.used_turns
    } else if (Array.isArray(events)) {
      for (const e of events) {
        if (!e || typeof e !== 'object') continue
        const ePhase = e.phase ?? e.data?.phase
        if (ePhase === phase && e.kind === 'step_result') {
          usedTurns += (typeof e.data?.turns === 'number' ? e.data.turns : 1)
        }
      }
    }
    if (usedTurns + requested_turns >= phaseLimit) {
      return {
        allowed: false,
        reason: 'turn_budget_exhausted',
        reservation: null,
      }
    }
  }

  // 6. Limite de contexto
  if (context_bytes !== undefined && context_bytes !== null) {
    const maxCtx = context_limit ?? 120000
    if (context_bytes >= maxCtx) {
      return {
        allowed: false,
        reason: 'context_limit_exceeded',
        reservation: null,
      }
    }
  }

  return {
    allowed: true,
    reason: null,
    reservation: {
      calls: requested_calls,
      usd: requested_usd,
      turns: requested_turns,
      family: family ?? '',
    },
  }
}
