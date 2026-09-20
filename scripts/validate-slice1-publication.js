import fs from 'node:fs'
import { AdeError } from '../src/journal/errors.js'

const EXPECTED_RECIPE = [
  'npm ci',
  'npm run test:parity',
  'node node_modules/vitest/vitest.mjs run tests/parity/crash-matrix.test.ts',
  'npm run test:durability-coverage',
]

const REQUIRED_MODULES = ['journal', 'step', 'lease', 'git', 'runner', 'contain']
const COMMIT_HASH_REGEX = /^[0-9a-f]{40}$/

/**
 * Valida a publicação de evidência Linux.
 * Aceita a declaração local somente como not_executed_locally e, se receber executed,
 * exige ciEvidencePath existente, sistema Linux, commit de 40 caracteres, paridade 93/0/0,
 * crash matrix 12/0 e seis coberturas de ao menos 85%.
 *
 * @param {any} declaration
 * @param {{ ciEvidencePath?: string }} [options]
 * @returns {any}
 */
export function validateLinuxPublication(declaration, options = {}) {
  if (!declaration || typeof declaration !== 'object') {
    throw new AdeError('linux_evidence_unverified', 'declaração Linux inválida', 2)
  }

  if (declaration.schema_version !== 1 || declaration.system !== 'linux') {
    throw new AdeError('linux_evidence_unverified', 'esquema ou sistema inválido para Linux', 2)
  }

  if (
    !Array.isArray(declaration.recipe) ||
    declaration.recipe.length !== EXPECTED_RECIPE.length ||
    !declaration.recipe.every((/** @type {string} */ cmd, /** @type {number} */ idx) => cmd === EXPECTED_RECIPE[idx])
  ) {
    throw new AdeError('linux_evidence_unverified', 'receita da declaração Linux não confere', 2)
  }

  if (declaration.status === 'not_executed_locally') {
    if (declaration.results !== null) {
      throw new AdeError(
        'linux_evidence_unverified',
        'declaração not_executed_locally deve ter results nulo',
        2,
      )
    }
    return declaration
  }

  if (declaration.status === 'executed') {
    const ciEvidencePath = options?.ciEvidencePath
    if (!ciEvidencePath || typeof ciEvidencePath !== 'string' || !fs.existsSync(ciEvidencePath)) {
      throw new AdeError(
        'linux_evidence_unverified',
        'artefato CI de evidência Linux não encontrado',
        2,
      )
    }

    let ciData
    try {
      ciData = JSON.parse(fs.readFileSync(ciEvidencePath, 'utf8'))
    } catch {
      throw new AdeError(
        'linux_evidence_unverified',
        'falha ao ler ou interpretar artefato CI de evidência Linux',
        2,
      )
    }

    if (!ciData || typeof ciData !== 'object') {
      throw new AdeError('linux_evidence_unverified', 'conteúdo do artefato CI inválido', 2)
    }

    if (ciData.system !== 'linux') {
      throw new AdeError('linux_evidence_unverified', 'artefato CI deve ser do sistema linux', 2)
    }

    if (!ciData.commit || typeof ciData.commit !== 'string' || !COMMIT_HASH_REGEX.test(ciData.commit)) {
      throw new AdeError('linux_evidence_unverified', 'commit do artefato CI inválido', 2)
    }

    if (
      !ciData.parity ||
      ciData.parity.passed !== 93 ||
      ciData.parity.failed !== 0 ||
      ciData.parity.skipped !== 0
    ) {
      throw new AdeError('linux_evidence_unverified', 'resultado de paridade do CI deve ser 93/0/0', 2)
    }

    if (
      !ciData.crash_matrix ||
      ciData.crash_matrix.passed !== 12 ||
      ciData.crash_matrix.failed !== 0
    ) {
      throw new AdeError('linux_evidence_unverified', 'resultado de crash matrix do CI deve ser 12/0', 2)
    }

    if (!ciData.coverage || typeof ciData.coverage !== 'object') {
      throw new AdeError('linux_evidence_unverified', 'seção de cobertura ausente no artefato CI', 2)
    }

    for (const mod of REQUIRED_MODULES) {
      const coverageVal = ciData.coverage[mod]
      if (typeof coverageVal !== 'number' || coverageVal < 85) {
        throw new AdeError(
          'linux_evidence_unverified',
          `cobertura insuficiente no módulo ${mod} (mínimo 85%): ${coverageVal}`,
          2,
        )
      }
    }

    return declaration
  }

  throw new AdeError(
    'linux_evidence_unverified',
    `status de declaração desconhecido: ${declaration.status}`,
    2,
  )
}
