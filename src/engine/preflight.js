// @ts-check
import { AdeError } from '../journal/errors.js'

/**
 * Ordem mandatória e fixa de execução das verificações do preflight.
 * @type {ReadonlyArray<string>}
 */
export const PREFLIGHT_CHECK_ORDER = Object.freeze([
  'proof_target',
  'dependencies',
  'build',
  'worktree',
  'input',
  'credential',
  'disk',
  'external_access',
])

/**
 * @typedef {Object} PreflightCheckResult
 * @property {'ready' | 'blocked'} status
 * @property {string | null} reason
 */

/**
 * @typedef {Object} PreflightCheckPort
 * @property {() => Promise<PreflightCheckResult> | PreflightCheckResult} check
 */

/**
 * @typedef {Object} PreflightCheckItem
 * @property {string} id
 * @property {'ready' | 'blocked'} status
 * @property {string | null} reason
 */

/**
 * @typedef {Object} PreflightFailure
 * @property {string} id
 * @property {string} reason
 */

/**
 * @typedef {Object} PreflightSummary
 * @property {boolean} ready
 * @property {PreflightFailure[]} failures
 * @property {PreflightCheckItem[]} checks
 * @property {number} calls_avoided
 */

/**
 * Executa o preflight puro e determinístico com portas injetadas na ordem fixa.
 *
 * @param {{
 *   checks: Record<string, PreflightCheckPort>,
 *   planned_paid_calls: number,
 *   consumed_paid_calls: number
 * }} params
 * @returns {Promise<PreflightSummary>}
 */
export async function runPreflight(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new AdeError('preflight_input_invalid', 'parâmetros de preflight inválidos', 4)
  }

  const { checks, planned_paid_calls, consumed_paid_calls } = params

  if (!Number.isInteger(planned_paid_calls) || planned_paid_calls < 0) {
    throw new AdeError(
      'preflight_input_invalid',
      'planned_paid_calls deve ser inteiro não negativo',
      4,
      { planned_paid_calls },
    )
  }

  if (!Number.isInteger(consumed_paid_calls) || consumed_paid_calls < 0) {
    throw new AdeError(
      'preflight_input_invalid',
      'consumed_paid_calls deve ser inteiro não negativo',
      4,
      { consumed_paid_calls },
    )
  }

  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new AdeError('preflight_input_invalid', 'checks deve ser um objeto', 4)
  }

  // Validação preliminar de todas as portas obrigatórias
  for (const id of PREFLIGHT_CHECK_ORDER) {
    if (!(id in checks) || checks[id] === null || checks[id] === undefined) {
      throw new AdeError('preflight_input_invalid', `porta ausente no preflight: ${id}`, 4, { id })
    }

    const port = checks[id]
    if (typeof port !== 'object' || Array.isArray(port) || typeof port.check !== 'function') {
      throw new AdeError('preflight_input_invalid', `porta inválida para ${id}`, 4, { id })
    }
  }

  /** @type {PreflightFailure[]} */
  const failures = []
  /** @type {PreflightCheckItem[]} */
  const checksResults = []

  // Execução sequencial na ordem fixa obrigatória
  for (const id of PREFLIGHT_CHECK_ORDER) {
    const port = checks[id]
    /** @type {any} */
    let checkResult

    try {
      checkResult = await port.check()
    } catch (err) {
      if (err instanceof AdeError) {
        throw err
      }
      throw new AdeError(
        'preflight_input_invalid',
        `falha ao executar porta ${id}: ${/** @type {Error} */ (err)?.message || String(err)}`,
        4,
        { id },
      )
    }

    if (!checkResult || typeof checkResult !== 'object' || Array.isArray(checkResult)) {
      throw new AdeError('preflight_input_invalid', `resultado inválido na porta ${id}`, 4, { id })
    }

    const { status, reason } = checkResult

    if (status !== 'ready' && status !== 'blocked') {
      throw new AdeError(
        'preflight_input_invalid',
        `status inválido na porta ${id}: ${status}`,
        4,
        { id, status },
      )
    }

    if (!('reason' in checkResult) || (typeof reason !== 'string' && reason !== null)) {
      throw new AdeError(
        'preflight_input_invalid',
        `reason inválido na porta ${id}: deve ser string ou null`,
        4,
        { id, reason },
      )
    }

    checksResults.push({
      id,
      status,
      reason,
    })

    if (status === 'blocked') {
      failures.push({
        id,
        reason: typeof reason === 'string' ? reason : '',
      })
    }
  }

  const ready = failures.length === 0
  const calls_avoided = ready ? 0 : Math.max(0, planned_paid_calls - consumed_paid_calls)

  return {
    ready,
    failures,
    checks: checksResults,
    calls_avoided,
  }
}
