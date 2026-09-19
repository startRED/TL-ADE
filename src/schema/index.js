import { Ajv } from 'ajv'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url))

const ajv = new Ajv({ allErrors: true })
/** @type {Map<string, import('ajv').ValidateFunction>} */
const validators = new Map()

/**
 * @param {string} schemaName
 */
function loadValidator(schemaName) {
  let validateFn = validators.get(schemaName)
  if (validateFn) return validateFn

  const filePath = path.join(SCHEMA_DIR, `${schemaName}.schema.json`)
  const schema = JSON.parse(readFileSync(filePath, 'utf8'))
  validateFn = ajv.compile(schema)
  validators.set(schemaName, validateFn)
  return validateFn
}

const LEGACY_SCHEMA_DIR = path.join(SCHEMA_DIR, 'legacy')

const legacyAjv = new Ajv({ allErrors: true })
/** @type {Map<string, import('ajv').ValidateFunction>} */
const legacyValidators = new Map()

/**
 * @param {string} schemaName
 * @param {number} [version=1]
 */
function loadLegacyValidator(schemaName, version = 1) {
  const key = `${schemaName}.v${version}`
  let validateFn = legacyValidators.get(key)
  if (validateFn) return validateFn

  const filePath = path.join(LEGACY_SCHEMA_DIR, `${schemaName}.v${version}.schema.json`)
  const schema = JSON.parse(readFileSync(filePath, 'utf8'))
  validateFn = legacyAjv.compile(schema)
  legacyValidators.set(key, validateFn)
  return validateFn
}


/**
 * @param {import('ajv').ErrorObject} error
 */
function errorPath(error) {
  if (error.keyword === 'additionalProperties') {
    const base = error.instancePath || ''
    return `${base}/${error.params.additionalProperty}`
  }
  return error.instancePath || '/'
}

/**
 * @param {string} schemaName
 * @param {unknown} doc
 * @returns {{valid: true, errors: []} | {valid: false, errors: Array<{path: string, message: string}>, code: 4}}
 */
export function validate(schemaName, doc) {
  const validateFn = loadValidator(schemaName)
  const ok = validateFn(doc)

  if (ok) {
    return { valid: true, errors: [] }
  }

  const errors = (validateFn.errors ?? []).map((error) => ({
    path: errorPath(error),
    message: error.message ?? 'invalid',
  }))

  // schema inválido (campo desconhecido ou forma que não valida) sai com código 4:
  // nunca é ignorado em silêncio (master-spec.md §4, tabela de exit codes).
  return { valid: false, errors, code: 4 }
}

/**
 * Valida documentos suportados (versões legadas e correntes).
 *
 * @param {string} schemaName
 * @param {unknown} doc
 * @returns {{valid: true, errors: [], formatVersion: number, current: boolean} | {valid: false, errors: Array<{path: string, message: string, code?: string}>, code: 4, formatVersion: number | null, current: false}}
 */
export function validateSupported(schemaName, doc) {
  const version =
    typeof doc === 'object' && doc !== null && typeof /** @type {any} */ (doc).format_version === 'number'
      ? /** @type {any} */ (doc).format_version
      : null

  if (version === 1) {
    const validateFn = loadLegacyValidator(schemaName, 1)
    const ok = validateFn(doc)

    if (ok) {
      return {
        valid: true,
        errors: [],
        formatVersion: 1,
        current: false,
      }
    }

    const errors = (validateFn.errors ?? []).map((error) => ({
      path: errorPath(error),
      message: error.message ?? 'invalid',
      code: error.keyword ?? 'schema_error',
    }))

    return {
      valid: false,
      errors,
      code: 4,
      formatVersion: 1,
      current: false,
    }
  }

  if (version === 2) {
    const validateFn = loadValidator(schemaName)
    const ok = validateFn(doc)

    if (ok) {
      return {
        valid: true,
        errors: [],
        formatVersion: 2,
        current: true,
      }
    }

    const errors = (validateFn.errors ?? []).map((error) => ({
      path: errorPath(error),
      message: error.message ?? 'invalid',
      code: error.keyword ?? 'schema_error',
    }))

    return {
      valid: false,
      errors,
      code: 4,
      formatVersion: 2,
      current: false,
    }
  }

  return {
    valid: false,
    errors: [
      {
        path: '/format_version',
        message: 'unsupported_result_format: Formato de resultado não suportado; esperado format_version 2.',
        code: 'unsupported_result_format',
      },
    ],
    code: 4,
    formatVersion: version,
    current: false,
  }
}

