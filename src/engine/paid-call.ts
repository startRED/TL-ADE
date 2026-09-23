// @ts-check
import { AdeError } from '../journal/errors.ts'
import { digest16 } from '../journal/canonical.ts'
import { DEFAULT_CONTEXT_LIMIT_BYTES, validateQuotaReceipt } from './budget.ts'

export type PaidCallAuthorization = {
  authorized: true
  family: string
  phase: string
  reservation: { calls: number; usd: number; turns: number; family: string} 
  quota_receipt: object
  context_bytes: number
  weekly_percent_cap: number
}

/**
 * Recusa a chamada paga quando a autorização não confere com o teto que será entregue à CLI.
 * O teto despachado tem de ser exatamente o valor reservado: divergência aqui é gasto acima do
 * que a missão autorizou.
 *
 * @param maxBudgetUsd teto efetivamente enviado ao modelo na chamada
 */
export function assertPaidAuthorization(authorization: any, maxBudgetUsd: any, now?: number | string | Date): void {
  const reservation = authorization?.reservation
  if (
    !authorization ||
    typeof authorization !== 'object' ||
    authorization.authorized !== true ||
    typeof authorization.family !== 'string' ||
    authorization.family.trim().length === 0 ||
    typeof authorization.phase !== 'string' ||
    !reservation ||
    typeof reservation !== 'object' ||
    reservation.family !== authorization.family ||
    !Number.isInteger(reservation.calls) || reservation.calls < 1 ||
    typeof reservation.usd !== 'number' || !Number.isFinite(reservation.usd) || reservation.usd <= 0 ||
    maxBudgetUsd !== reservation.usd ||
    !Number.isInteger(reservation.turns) || reservation.turns < 1 ||
    !Number.isSafeInteger(authorization.context_bytes) || authorization.context_bytes < 0 ||
    typeof authorization.weekly_percent_cap !== 'number' ||
    !Number.isFinite(authorization.weekly_percent_cap) ||
    authorization.weekly_percent_cap <= 0
  ) {
    throw new AdeError('paid_call_unauthorized', 'autorização de chamada paga inválida', 4)
  }

  if (authorization.context_bytes >= DEFAULT_CONTEXT_LIMIT_BYTES) {
    throw new AdeError('context_limit_exceeded', 'contexto acima do limite da chamada paga', 4)
  }

  const quota = validateQuotaReceipt(authorization.quota_receipt, {
    family: authorization.family,
    max_percent: authorization.weekly_percent_cap,
    now,
  })
  if (!quota.ok) {
    throw new AdeError(quota.reason ?? 'paid_call_unauthorized', 'recibo de cota inválido para chamada paga', 4)
  }
}

/**
 * Embrulha o `step()` write-ahead do motor para que todo efeito `model_call` seja barrado antes
 * do spawn quando a autorização não cobre o teto da chamada, e para que a autorização fique
 * durável no registro do passo junto com o teto despachado.
 */
export function authorizedStep(step: Function, authorization: PaidCallAuthorization, now?: number | string | Date): Function {
  return (spec: any, effect: any) => {
    if (spec?.effect_class !== 'model_call') {
      return step(spec, effect)
    }
    assertPaidAuthorization(authorization, spec?.input?.max_budget_usd, now)
    return step(
      { ...spec, input: { ...spec.input, authorization: digest16(authorization) } },
      effect,
    )
  }
}
