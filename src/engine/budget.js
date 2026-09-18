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
