import fs from 'node:fs'

/**
 * @typedef {'transient' | 'harness' | 'environment' | 'semantic' | 'verification' | 'authorization' | 'budget' | 'scope' | 'state_integrity' | 'security' | 'unknown'} FailureClass
 */

/**
 * @typedef {'retry' | 'park' | 'stop'} Movement
 */

/**
 * @typedef {'released' | 'charged'} Charge
 */

/**
 * Classes de falha fechadas do TL-ADE na ordem literal da interface.
 * @type {FailureClass[]}
 */
export const FAILURE_CLASSES = [
  'transient',
  'harness',
  'environment',
  'semantic',
  'verification',
  'authorization',
  'budget',
  'scope',
  'state_integrity',
  'security',
  'unknown',
]

/**
 * Limites fechados de retries por classe de falha.
 * @type {Record<string, number>}
 */
export const RETRY_LIMITS = {
  transient: 3,
  harness: 1,
}

/**
 * Expressão regular para identificar falhas transitórias em stderr.
 */
export const TRANSIENT_RE =
  /(rate.?limit|\b429\b|\b503\b|\b502\b|overloaded|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i

/**
 * Expressão regular para identificar falhas de ambiente em stderr.
 */
export const ENVIRONMENT_RE =
  /(ENOENT|EINVAL|EACCES|not recognized|não pode encontrar o arquivo|WinError \[23\]|command not found)/i

/**
 * Classifica a falha de acordo com os sinais observados na execução.
 *
 * @param {Object} input
 * @param {string} input.state
 * @param {number | null} [input.exitCode]
 * @param {string} [input.stderr]
 * @param {Record<string, any> | null} [input.unitResult]
 * @param {boolean} [input.resultPresent]
 * @returns {FailureClass}
 */
export function classifyFailure({
  state,
  exitCode = null,
  stderr = '',
  unitResult = null,
  resultPresent = false,
}) {
  if (state === 'start_failed') {
    return 'environment'
  }
  if (unitResult?.outcome === 'blocked' && unitResult?.blocker === 'authorization') {
    return 'authorization'
  }
  const err = typeof stderr === 'string' ? stderr : ''
  if (TRANSIENT_RE.test(err)) {
    return 'transient'
  }
  if (ENVIRONMENT_RE.test(err)) {
    return 'environment'
  }
  if (state === 'timeout' || state === 'crashed') {
    return 'harness'
  }
  if (state === 'exited' && exitCode === 0 && !resultPresent) {
    return 'harness'
  }
  return 'unknown'
}

/**
 * Determina o movimento da política para a classe de falha informada.
 *
 * @param {string} failureClass
 * @returns {Movement}
 */
export function movementOf(failureClass) {
  if (!FAILURE_CLASSES.includes(/** @type {FailureClass} */ (failureClass))) {
    throw new TypeError('classe de falha inválida')
  }
  if (failureClass === 'transient' || failureClass === 'harness') {
    return 'retry'
  }
  if (
    failureClass === 'authorization' ||
    failureClass === 'budget' ||
    failureClass === 'security' ||
    failureClass === 'state_integrity'
  ) {
    return 'stop'
  }
  return 'park'
}

/**
 * Determina o tipo de cobrança referente à classe de falha informada.
 *
 * @param {string} failureClass
 * @returns {Charge}
 */
export function chargeOfClass(failureClass) {
  if (!FAILURE_CLASSES.includes(/** @type {FailureClass} */ (failureClass))) {
    throw new TypeError('classe de falha inválida')
  }
  if (failureClass === 'environment') {
    return 'released'
  }
  return 'charged'
}

/**
 * @typedef {Object} PolicyLimits
 * @property {number} [transientRetries]
 * @property {number} [harnessRetries]
 */

/**
 * @typedef {Object} PolicyResult
 * @property {'ok' | 'parked' | 'stopped'} outcome
 * @property {number} attempts
 * @property {number[]} delaysMs
 * @property {string | null} failureClass
 * @property {Charge} charge
 * @property {boolean} batchStopped
 * @property {string | null} reason
 */

/**
 * @typedef {Object} ResultRead
 * @property {boolean} resultPresent
 * @property {Record<string, any> | null} unitResult
 */

/**
 * Leitura padrão de produção do result file.
 *
 * @param {string} resultFile
 * @returns {ResultRead}
 */
export function readResultFile(resultFile) {
  try {
    const content = fs.readFileSync(resultFile, 'utf8')
    return { resultPresent: true, unitResult: JSON.parse(content) }
  } catch {
    return { resultPresent: false, unitResult: null }
  }
}

/**
 * Executa o runner sob a política de falha, aplicando retries determinísticos com backoff.
 *
 * @param {Object} options
 * @param {(attempt: number) => Promise<any>} options.runner
 * @param {string} options.resultFile
 * @param {PolicyLimits} [options.limits]
 * @param {number} [options.backoffBaseMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(resultFile: string) => ResultRead} [options.readResult]
 * @returns {Promise<PolicyResult>}
 */
export async function runWithPolicy({
  runner,
  resultFile,
  limits = { transientRetries: 3, harnessRetries: 1 },
  backoffBaseMs = 100,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readResult = readResultFile,
}) {
  if (typeof runner !== 'function') {
    throw new TypeError('runner inválido')
  }
  if (typeof resultFile !== 'string' || !resultFile) {
    throw new TypeError('resultFile inválido')
  }
  if (typeof readResult !== 'function') {
    throw new TypeError('readResult inválido')
  }

  const transientRetries = limits?.transientRetries ?? RETRY_LIMITS.transient
  const harnessRetries = limits?.harnessRetries ?? RETRY_LIMITS.harness

  /** @type {number[]} */
  const delaysMs = []
  /** @type {Record<string, number>} */
  const retriesUsed = { transient: 0, harness: 0 }

  let attempt = 0
  while (true) {
    const res = await runner(attempt)

    const { resultPresent, unitResult } = readResult(resultFile)

    if (
      res?.state === 'exited' &&
      res?.exitCode === 0 &&
      resultPresent &&
      unitResult?.outcome !== 'blocked'
    ) {
      return {
        outcome: 'ok',
        attempts: attempt + 1,
        delaysMs,
        failureClass: null,
        charge: 'charged',
        batchStopped: false,
        reason: null,
      }
    }

    /** @type {FailureClass} */
    let failureClass
    if (res?.failureClass !== undefined && res?.failureClass !== null) {
      if (!FAILURE_CLASSES.includes(/** @type {FailureClass} */ (res.failureClass))) {
        throw new TypeError('classe de falha inválida')
      }
      failureClass = /** @type {FailureClass} */ (res.failureClass)
    } else {
      failureClass = classifyFailure({
        state: res?.state,
        exitCode: res?.exitCode ?? null,
        stderr: res?.stderr ?? '',
        unitResult,
        resultPresent,
      })
    }

    const movement = movementOf(failureClass)

    if (movement === 'stop') {
      return {
        outcome: 'stopped',
        batchStopped: true,
        failureClass,
        charge: chargeOfClass(failureClass),
        reason: failureClass,
        attempts: attempt + 1,
        delaysMs,
      }
    }

    if (movement === 'park') {
      return {
        outcome: 'parked',
        batchStopped: false,
        failureClass,
        charge: chargeOfClass(failureClass),
        reason: failureClass,
        attempts: attempt + 1,
        delaysMs,
      }
    }

    if (movement === 'retry') {
      const maxRetries =
        failureClass === 'transient' ? transientRetries : harnessRetries
      const currentRetries = retriesUsed[failureClass] ?? 0

      if (currentRetries < maxRetries) {
        retriesUsed[failureClass] = currentRetries + 1
        const delay = backoffBaseMs * 2 ** attempt
        delaysMs.push(delay)
        await sleep(delay)
        attempt++
        continue
      }

      return {
        outcome: 'parked',
        reason: `${failureClass}_retries_exhausted`,
        failureClass,
        charge: chargeOfClass(failureClass),
        batchStopped: false,
        attempts: attempt + 1,
        delaysMs,
      }
    }
  }
}
