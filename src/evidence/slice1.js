import { AdeError } from '../journal/errors.js'

/**
 * As doze células normativas da matriz de queda do Slice 1.
 *
 * @type {readonly string[]}
 */
export const CRASH_MATRIX_CELLS = Object.freeze([
  'engine_before_spawn',
  'worker_before_spawn',
  'engine_after_maker_effect',
  'worker_after_maker_effect',
  'engine_before_contain',
  'worker_before_contain',
  'engine_after_contain',
  'worker_after_contain',
  'engine_before_commit',
  'worker_before_commit',
  'engine_after_commit',
  'worker_after_commit',
])

/**
 * Os seis módulos duráveis com cobertura exigida no Slice 1.
 *
 * @type {readonly string[]}
 */
export const COVERAGE_MODULES = Object.freeze([
  'journal',
  'step',
  'lease',
  'git',
  'runner',
  'contain',
])

const HASH_REGEX = /^[0-9a-f]{40}$/

/**
 * @typedef {Object} ParityResult
 * @property {number} passed
 * @property {number} failed
 * @property {number} skipped
 */

/**
 * @typedef {Object} CrashMatrixResult
 * @property {number} passed
 * @property {number} failed
 * @property {Record<string, 'passed' | 'failed'>} cells
 */

/**
 * @typedef {Object} CoverageResult
 * @property {number} journal
 * @property {number} step
 * @property {number} lease
 * @property {number} git
 * @property {number} runner
 * @property {number} contain
 */

/**
 * Formato normativo EvidenceV1 do Slice 1.
 *
 * @typedef {Object} EvidenceV1
 * @property {1} schema_version
 * @property {'executed'} status
 * @property {string} commit
 * @property {string} tree
 * @property {'windows'} system
 * @property {string} node_version
 * @property {4} workers
 * @property {number} duration_ms
 * @property {ParityResult} parity
 * @property {CrashMatrixResult} crash_matrix
 * @property {CoverageResult} coverage
 */

/**
 * Valida os dados de evidência pura do Slice 1 segundo as invariantes normativas.
 *
 * @param {unknown} evidence
 * @returns {EvidenceV1}
 */
export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    throw new AdeError('slice1_evidence_invalid', 'Evidência deve ser um objeto', 2)
  }

  const ev = /** @type {Record<string, any>} */ (evidence)

  if (ev.schema_version !== 1) {
    throw new AdeError('slice1_evidence_invalid', `schema_version inválido: ${ev.schema_version}`, 2)
  }

  if (ev.status !== 'executed') {
    throw new AdeError('slice1_evidence_invalid', `status inválido: ${ev.status}`, 2)
  }

  if (typeof ev.commit !== 'string' || !HASH_REGEX.test(ev.commit)) {
    throw new AdeError('slice1_evidence_invalid', `commit hash inválido: ${ev.commit}`, 2)
  }

  if (typeof ev.tree !== 'string' || !HASH_REGEX.test(ev.tree)) {
    throw new AdeError('slice1_evidence_invalid', `tree hash inválido: ${ev.tree}`, 2)
  }

  if (ev.system !== 'windows') {
    throw new AdeError('slice1_evidence_invalid', `system incompatível: ${ev.system}`, 2)
  }

  if (typeof ev.node_version !== 'string' || !ev.node_version.trim()) {
    throw new AdeError('slice1_evidence_invalid', `node_version inválido: ${ev.node_version}`, 2)
  }

  if (ev.workers !== 4) {
    throw new AdeError('slice1_evidence_invalid', `workers inválido: ${ev.workers}`, 2)
  }

  if (typeof ev.duration_ms !== 'number' || Number.isNaN(ev.duration_ms) || ev.duration_ms < 0 || ev.duration_ms > 360000) {
    throw new AdeError('slice1_evidence_invalid', `duration_ms inválido: ${ev.duration_ms}`, 2)
  }

  // Paridade: 93 passed, 0 failed, 0 skipped
  if (!ev.parity || typeof ev.parity !== 'object') {
    throw new AdeError('slice1_evidence_invalid', 'parity ausente ou inválido', 2)
  }
  if (ev.parity.passed !== 93 || ev.parity.failed !== 0 || ev.parity.skipped !== 0) {
    throw new AdeError(
      'slice1_evidence_invalid',
      `parity incompleta: passed=${ev.parity.passed}, failed=${ev.parity.failed}, skipped=${ev.parity.skipped}`,
      2,
    )
  }

  // Crash matrix: 12 passed, 0 failed, todas as 12 células 'passed'
  if (!ev.crash_matrix || typeof ev.crash_matrix !== 'object') {
    throw new AdeError('slice1_evidence_invalid', 'crash_matrix ausente ou inválido', 2)
  }
  if (ev.crash_matrix.passed !== 12 || ev.crash_matrix.failed !== 0) {
    throw new AdeError(
      'slice1_evidence_invalid',
      `crash_matrix incompleta: passed=${ev.crash_matrix.passed}, failed=${ev.crash_matrix.failed}`,
      2,
    )
  }
  if (!ev.crash_matrix.cells || typeof ev.crash_matrix.cells !== 'object') {
    throw new AdeError('slice1_evidence_invalid', 'crash_matrix.cells ausente ou inválido', 2)
  }
  for (const cell of CRASH_MATRIX_CELLS) {
    if (ev.crash_matrix.cells[cell] !== 'passed') {
      throw new AdeError(
        'slice1_evidence_invalid',
        `célula crash_matrix '${cell}' não foi aprovada (valor: ${ev.crash_matrix.cells[cell]})`,
        2,
      )
    }
  }

  // Cobertura: todos os 6 módulos com cobertura >= 85
  if (!ev.coverage || typeof ev.coverage !== 'object') {
    throw new AdeError('slice1_evidence_invalid', 'coverage ausente ou inválido', 2)
  }
  for (const mod of COVERAGE_MODULES) {
    const val = ev.coverage[mod]
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 85) {
      throw new AdeError(
        'slice1_evidence_invalid',
        `cobertura do módulo '${mod}' insuficiente ou ausente: ${val}`,
        2,
      )
    }
  }

  return /** @type {EvidenceV1} */ (evidence)
}
