import Ajv from 'ajv'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url))

const ajv = new Ajv({ allErrors: true })
const validators = new Map()

function loadValidator(schemaName) {
  let validateFn = validators.get(schemaName)
  if (validateFn) return validateFn

  const filePath = path.join(SCHEMA_DIR, `${schemaName}.schema.json`)
  const schema = JSON.parse(readFileSync(filePath, 'utf8'))
  validateFn = ajv.compile(schema)
  validators.set(schemaName, validateFn)
  return validateFn
}

function errorPath(error) {
  if (error.keyword === 'additionalProperties') {
    const base = error.instancePath || ''
    return `${base}/${error.params.additionalProperty}`
  }
  return error.instancePath || '/'
}

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
