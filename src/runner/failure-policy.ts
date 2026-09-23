import fs from 'node:fs'

export type FailureClass = 'transient' | 'harness' | 'environment' | 'semantic' | 'verification' | 'authorization' | 'budget' | 'scope' | 'state_integrity' | 'security' | 'unknown'

export type Movement = 'retry' | 'park' | 'stop'

export type Charge = 'released' | 'charged'

/**
 * Classes de falha fechadas do TL-ADE na ordem literal da interface.
 */
export const FAILURE_CLASSES: FailureClass[] = [
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
 */
export const RETRY_LIMITS: Record<string,number> = {
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
 */
export function classifyFailure({
  state,
  exitCode = null,
  stderr = '',
  unitResult = null,
  resultPresent = false,
}: { state: string; exitCode?: number|null; stderr?: string; unitResult?: Record<string,any>|null; resultPresent?: boolean }): FailureClass {
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
 */
export function movementOf(failureClass: string): Movement {
  if (!FAILURE_CLASSES.includes((failureClass as FailureClass))) {
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
 */
export function chargeOfClass(failureClass: string): Charge {
  if (!FAILURE_CLASSES.includes((failureClass as FailureClass))) {
    throw new TypeError('classe de falha inválida')
  }
  if (failureClass === 'environment') {
    return 'released'
  }
  return 'charged'
}

export type PolicyLimits = {
  transientRetries?: number
  harnessRetries?: number
}

export type PolicyResult = {
  outcome: 'ok' | 'parked' | 'stopped'
  attempts: number
  delaysMs: number[]
  failureClass: string | null
  charge: Charge
  batchStopped: boolean
  reason: string | null
}

export type ResultRead = {
  resultPresent: boolean
  unitResult: Record<string, any> | null
}

/**
 * Leitura padrão de produção do result file.
 *
 */
export function readResultFile(resultFile: string): ResultRead {
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
 */
export async function runWithPolicy({
  runner,
  resultFile,
  limits = { transientRetries: 3, harnessRetries: 1 },
  backoffBaseMs = 100,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readResult = readResultFile,
}: { runner: (attempt: number) => Promise<any>; resultFile: string; limits?: PolicyLimits; backoffBaseMs?: number; sleep?: (ms: number) => Promise<void>; readResult?: (resultFile: string) => ResultRead }): Promise<PolicyResult> {
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

  const delaysMs: number[] = []
  const retriesUsed: Record<string,number> = { transient: 0, harness: 0 }

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

    let failureClass: FailureClass
    if (res?.failureClass !== undefined && res?.failureClass !== null) {
      if (!FAILURE_CLASSES.includes((res.failureClass as FailureClass))) {
        throw new TypeError('classe de falha inválida')
      }
      failureClass = (res.failureClass as FailureClass)
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
