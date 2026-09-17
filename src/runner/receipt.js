import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'

/**
 * @typedef {'starting' | 'running' | 'exited' | 'timeout' | 'crashed' | 'start_failed'} ReceiptState
 */

/**
 * @typedef {Object} ProcessFingerprint
 * @property {number} pid
 * @property {string | null} start_time
 * @property {string} host
 */

/**
 * @typedef {Object} SpawnRequest
 * @property {string} unit
 * @property {string} authorization
 * @property {string} cwd
 * @property {string[]} argv
 * @property {number} timeout
 * @property {string} result_file
 */

/**
 * @typedef {Object} Receipt
 * @property {number} schema
 * @property {ReceiptState} state
 * @property {string} mission_id
 * @property {string} step_id
 * @property {string} request_digest
 * @property {SpawnRequest} request
 * @property {ProcessFingerprint | null} process_fingerprint
 * @property {string} started_at
 * @property {string | null} exited_at
 * @property {number | null} exit_code
 * @property {string | null} reason
 */

/** @type {ReceiptState[]} */
export const RECEIPT_STATES = [
  'starting',
  'running',
  'exited',
  'timeout',
  'crashed',
  'start_failed',
]

const TERMINAL_STATES = ['exited', 'timeout', 'crashed', 'start_failed']

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Valida se o valor é um instante ISO 8601 UTC no formato de `Date#toISOString()`.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) {
    return false
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return false
  }
  // Só aceita o texto que o próprio `Date#toISOString()` produziria: rejeita instantes
  // normalizados pelo parse, como '2026-02-30T00:00:00.000Z' ou '2026-01-01T24:00:00.000Z'.
  return new Date(parsed).toISOString() === value
}

/**
 * Valida a estrutura e os tipos do pedido de spawn.
 *
 * @param {unknown} request
 * @returns {request is SpawnRequest}
 */
export function isValidRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return false
  }
  const r = /** @type {Record<string, unknown>} */ (request)
  const keys = Object.keys(r)
  if (keys.length !== 6) {
    return false
  }
  if (typeof r.unit !== 'string' || !r.unit) return false
  if (typeof r.authorization !== 'string' || !r.authorization) return false
  if (typeof r.cwd !== 'string' || !r.cwd) return false
  if (!Array.isArray(r.argv) || r.argv.length === 0 || !r.argv.every((a) => typeof a === 'string')) {
    return false
  }
  if (typeof r.timeout !== 'number' || !Number.isFinite(r.timeout) || r.timeout <= 0) {
    return false
  }
  if (typeof r.result_file !== 'string' || !r.result_file) return false
  return true
}

/**
 * Valida a estrutura e os tipos da impressão digital do processo.
 *
 * @param {unknown} fp
 * @returns {fp is ProcessFingerprint}
 */
export function isValidFingerprint(fp) {
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) {
    return false
  }
  const f = /** @type {Record<string, unknown>} */ (fp)
  const keys = Object.keys(f)
  if (keys.length !== 3) {
    return false
  }
  if (!('pid' in f && 'start_time' in f && 'host' in f)) {
    return false
  }
  if (typeof f.pid !== 'number' || !Number.isInteger(f.pid) || f.pid <= 0) {
    return false
  }
  if (f.start_time !== null && !isValidIsoInstant(f.start_time)) {
    return false
  }
  if (typeof f.host !== 'string' || !f.host) {
    return false
  }
  return true
}

/**
 * Retorna o caminho do arquivo de recibo durável.
 *
 * @param {string} missionDir
 * @param {string} stepId
 * @returns {string}
 */
export function receiptPath(missionDir, stepId) {
  if (typeof missionDir !== 'string' || !missionDir) {
    throw new TypeError('missionDir inválido')
  }
  if (typeof stepId !== 'string' || !stepId) {
    throw new TypeError('stepId inválido')
  }
  return path.join(missionDir, 'jobs', stepId + '.json')
}

/**
 * Calcula o digest SHA-256 canônico do pedido de spawn.
 *
 * @param {unknown} request
 * @returns {string}
 */
export function requestDigest(request) {
  if (!isValidRequest(request)) {
    throw new TypeError('request inválido')
  }
  return createHash('sha256').update(canonicalize(request)).digest('hex')
}

/**
 * Cria o recibo inicial no estado 'starting'.
 *
 * @param {{
 *   missionId: string,
 *   stepId: string,
 *   request: unknown,
 *   now?: () => string
 * }} input
 * @returns {Receipt}
 */
export function startingReceipt({
  missionId,
  stepId,
  request,
  now = () => new Date().toISOString(),
}) {
  if (typeof missionId !== 'string' || !missionId) {
    throw new TypeError('missionId inválido')
  }
  if (typeof stepId !== 'string' || !stepId) {
    throw new TypeError('stepId inválido')
  }
  if (!isValidRequest(request)) {
    throw new TypeError('request inválido')
  }
  const startedAt = now()
  if (!isValidIsoInstant(startedAt)) {
    throw new TypeError('now inválido')
  }

  return {
    schema: 1,
    state: 'starting',
    mission_id: missionId,
    step_id: stepId,
    request_digest: requestDigest(request),
    request,
    process_fingerprint: null,
    started_at: startedAt,
    exited_at: null,
    exit_code: null,
    reason: null,
  }
}

/**
 * Transiciona o recibo de 'starting' para 'running'.
 *
 * @param {Receipt} receipt
 * @param {unknown} fingerprint
 * @param {string} [nowIso]
 * @returns {Receipt}
 */
export function withRunning(receipt, fingerprint, nowIso = new Date().toISOString()) {
  if (!isValidReceipt(receipt)) {
    throw new TypeError('receipt inválido')
  }
  if (receipt.state !== 'starting') {
    throw new TypeError('transição de recibo inválida')
  }
  if (!isValidFingerprint(fingerprint)) {
    throw new TypeError('fingerprint inválido')
  }
  if (!isValidIsoInstant(nowIso)) {
    throw new TypeError('nowIso inválido')
  }

  return {
    ...receipt,
    state: 'running',
    process_fingerprint: fingerprint,
    started_at: nowIso,
  }
}

/**
 * Transiciona o recibo para um estado terminal fechado.
 *
 * @param {Receipt} receipt
 * @param {'exited' | 'timeout' | 'crashed' | 'start_failed'} state
 * @param {{
 *   exitCode?: number | null,
 *   reason?: string | null,
 *   nowIso?: string
 * }} [patch]
 * @returns {Receipt}
 */
export function withTerminal(
  receipt,
  state,
  { exitCode = null, reason = null, nowIso = new Date().toISOString() } = {},
) {
  if (!TERMINAL_STATES.includes(state)) {
    throw new TypeError('state terminal inválido')
  }
  if (!isValidReceipt(receipt)) {
    throw new TypeError('receipt inválido')
  }
  if (
    (state === 'start_failed' && receipt.state !== 'starting') ||
    (state !== 'start_failed' && receipt.state !== 'running')
  ) {
    throw new TypeError('transição de recibo inválida')
  }
  if (exitCode !== null && !Number.isInteger(exitCode)) {
    throw new TypeError('exitCode inválido')
  }
  if (reason !== null && typeof reason !== 'string') {
    throw new TypeError('reason inválido')
  }
  if (!isValidIsoInstant(nowIso)) {
    throw new TypeError('nowIso inválido')
  }

  return {
    ...receipt,
    state,
    exit_code: exitCode,
    reason,
    exited_at: nowIso,
  }
}

/**
 * Valida se um objeto lido cumpre a forma e os invariantes do recibo durável.
 *
 * @param {unknown} parsed
 * @returns {parsed is Receipt}
 */
export function isValidReceipt(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const r = /** @type {Record<string, unknown>} */ (parsed)
  if (r.schema !== 1) return false
  if (
    typeof r.state !== 'string' ||
    !RECEIPT_STATES.includes(/** @type {ReceiptState} */ (r.state))
  ) {
    return false
  }
  if (typeof r.mission_id !== 'string' || !r.mission_id) return false
  if (typeof r.step_id !== 'string' || !r.step_id) return false
  if (typeof r.request_digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.request_digest)) {
    return false
  }
  if (!isValidRequest(r.request)) return false
  // `canonicalize` recusa texto que não é Unicode válido (ex.: surrogate solitário vindo de um
  // `\uD800` escapado no JSON do arquivo). A falha bruta é tratada como recibo inválido, para que
  // `readReceipt` a converta em AdeError('receipt_corrupt', ...) como promete a interface.
  try {
    if (requestDigest(r.request) !== r.request_digest) return false
  } catch {
    return false
  }
  if (!isValidIsoInstant(r.started_at)) return false

  if (r.state === 'starting' || r.state === 'start_failed') {
    if (r.process_fingerprint !== null) return false
  } else {
    if (!isValidFingerprint(r.process_fingerprint)) return false
  }

  if (r.state === 'starting' || r.state === 'running') {
    if (r.exited_at !== null || r.exit_code !== null || r.reason !== null) return false
  } else {
    if (!isValidIsoInstant(r.exited_at)) return false
    if (r.exit_code !== null && (typeof r.exit_code !== 'number' || !Number.isInteger(r.exit_code))) {
      return false
    }
    if (r.reason !== null && typeof r.reason !== 'string') return false
  }

  return true
}

/**
 * Grava o recibo duravelmente via tmp + fsync + rename.
 *
 * @param {string} file
 * @param {Receipt} receipt
 * @param {{ fsyncSync?: (fd: number) => void }} [deps]
 * @returns {void}
 */
export function writeReceipt(file, receipt, { fsyncSync = fs.fsyncSync } = {}) {
  if (typeof file !== 'string' || !file) {
    throw new TypeError('file inválido')
  }
  if (!isValidReceipt(receipt)) {
    throw new TypeError('receipt inválido')
  }
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  const content = JSON.stringify(receipt) + '\n'

  /** @type {number | undefined} */
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeSync(fd, content)
    fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignora erro ao fechar
      }
      fd = undefined
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignora erro ao remover tmp se já inexistente
    }
    throw err
  }
}

/**
 * Lê o recibo de disco. Devolve null se inexistente (ENOENT) ou lança AdeError se corrompido.
 *
 * @param {string} file
 * @returns {Receipt | null}
 */
export function readReceipt(file) {
  if (typeof file !== 'string' || !file) {
    throw new TypeError('file inválido')
  }
  /** @type {string} */
  let content
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return null
    }
    throw err
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new AdeError('receipt_corrupt', 'recibo ilegível: ' + file, 2, { file })
  }

  if (!isValidReceipt(parsed)) {
    throw new AdeError('receipt_corrupt', 'recibo ilegível: ' + file, 2, { file })
  }

  return parsed
}

/**
 * Mapeia o estado do recibo para a classificação de cobrança.
 *
 * @param {string} state
 * @returns {'released' | 'charged'}
 */
export function chargeOf(state) {
  if (!RECEIPT_STATES.includes(/** @type {ReceiptState} */ (state))) {
    throw new TypeError('state inválido')
  }
  if (state === 'starting' || state === 'start_failed') {
    return 'released'
  }
  return 'charged'
}
