import { Ajv } from 'ajv'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url))

const ajv = new Ajv({ allErrors: true })
/** @type {Map<string, import('ajv').ValidateFunction>} */
const validators = new Map()

const CANONICAL_SURFACES = new Set([
  'auth',
  'secrets',
  'money',
  'billing',
  'personal_data',
  'migration',
  'data_loss',
  'public_api',
  'external_effect',
  'concurrency',
  'durability',
  'security_boundary',
  'supply_chain',
  'agent_control_plane',
  'autorizacao',
  'segredo',
  'dinheiro',
  'migracao',
  'perda_de_dados',
  'controle_do_agente',
])

const SENSITIVE_SURFACES = new Set([
  'auth',
  'secrets',
  'money',
  'billing',
  'personal_data',
  'migration',
  'data_loss',
  'security_boundary',
  'supply_chain',
  'agent_control_plane',
  'autorizacao',
  'segredo',
  'dinheiro',
  'migracao',
  'perda_de_dados',
  'controle_do_agente',
])

const TRACEABLE_REF_REGEX = /^[a-z0-9_-]+:\S+$/i


const IN_MEMORY_LEGACY_SCHEMAS = {
  'plan.v1': {
    type: 'object',
    additionalProperties: false,
    required: [
      'format_version',
      'id',
      'mission_id',
      'immutable_digest',
      'authorization',
      'phases',
      'mission_budget',
      'budget',
    ],
    properties: {
      format_version: { type: 'integer', enum: [1] },
      id: { type: 'string' },
      mission_id: { type: 'string' },
      immutable_digest: { type: 'string' },
      authorization: {
        type: 'object',
        additionalProperties: false,
        required: ['autonomy', 'permitted_effects', 'eligible_skills'],
        properties: {
          autonomy: { enum: ['safe', 'controlled', 'restricted'] },
          permitted_effects: { type: 'array', items: { type: 'string' } },
          eligible_skills: { type: 'array', items: { type: 'string' } },
        },
      },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['epics'],
          properties: {
            epics: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['stories'],
                properties: {
                  stories: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      mission_budget: {
        type: 'object',
        additionalProperties: false,
        required: ['max_usd'],
        properties: {
          max_usd: { type: 'number' },
          max_wall_clock_seconds: { type: 'integer', minimum: 1 },
          max_parked_units: { type: 'integer', minimum: 0 },
          max_subscription_weekly_percent: { type: 'number', minimum: 0, maximum: 50 },
        },
      },
      budget: {
        type: 'object',
        additionalProperties: false,
        required: ['max_model_calls', 'max_rework_rounds'],
        properties: {
          max_model_calls: { type: 'integer' },
          max_rework_rounds: { type: 'integer' },
        },
      },
    },
  },
  'task-contract.v1': {
    type: 'object',
    additionalProperties: false,
    required: [
      'format_version',
      'id',
      'title',
      'complexity',
      'task',
      'guardrails',
      'requirements',
      'scenarios',
      'evals',
      'skills',
      'roles',
      'budget',
    ],
    properties: {
      format_version: { type: 'integer', enum: [1] },
      id: { type: 'string' },
      title: { type: 'string' },
      complexity: { enum: ['trivial', 'bounded', 'feature', 'subsystem', 'project'] },
      needs_ui: { type: 'boolean' },
      task: { type: 'string' },
      guardrails: {
        type: 'object',
        additionalProperties: false,
        required: ['scope_paths', 'do_not_touch', 'autonomy'],
        properties: {
          scope_paths: { type: 'array', items: { type: 'string' } },
          do_not_touch: { type: 'array', items: { type: 'string' } },
          sensitive_paths: { type: 'array', items: { type: 'string' } },
          autonomy: { enum: ['safe', 'controlled', 'restricted'] },
          ask_operator: { type: 'array', items: { type: 'string' } },
        },
      },
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'ears'],
          properties: {
            id: { type: 'string' },
            ears: { type: 'string' },
          },
        },
      },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'given', 'when', 'then'],
          properties: Object.assign(
            {
              id: { type: 'string' },
              given: { type: 'string' },
              when: { type: 'string' },
              evals: { type: 'array', items: { type: 'string' } },
            },
            JSON.parse('{"then":{"type":"string"}}'),
          ),
        },
      },
      evals: { type: 'array' },
      skills: { type: 'array', items: { type: 'string' } },
      roles: { type: 'object' },
      budget: { type: 'object' },
    },
  },
}

/**
 * @param {string} schemaName
 */
function loadValidator(schemaName) {
  let validateFn = validators.get(schemaName)
  if (validateFn) return validateFn

  const targetFile = schemaName === 'verifier' ? 'eval.schema.json' : `${schemaName}.schema.json`
  const filePath = path.join(SCHEMA_DIR, targetFile)
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
  const legacySchemas = /** @type {Record<string, any>} */ (IN_MEMORY_LEGACY_SCHEMAS)
  let schema
  if (existsSync(filePath)) {
    schema = JSON.parse(readFileSync(filePath, 'utf8'))
  } else if (legacySchemas[key]) {
    schema = legacySchemas[key]
  } else {
    throw new Error(`Legacy schema not found: ${key}`)
  }

  validateFn = legacyAjv.compile(schema)
  legacyValidators.set(key, validateFn)
  return validateFn
}

/**
 * @param {import('ajv').ErrorObject} error
 */
function errorPath(error) {
  const base = error.instancePath || ''
  if (error.keyword === 'additionalProperties') {
    return `${base}/${error.params.additionalProperty}`
  }
  if (error.keyword === 'required') {
    return `${base}/${error.params.missingProperty}`
  }
  return error.instancePath || '/'
}

/**
 * @param {string} schemaName
 * @param {unknown} doc
 * @returns {{valid: true, errors: []} | {valid: false, errors: Array<{path: string, message: string, code?: string}>, code: 4}}
 */
export function validate(schemaName, doc) {
  const validateFn = loadValidator(schemaName)
  const ok = validateFn(doc)

  const errors = ok
    ? []
    : (validateFn.errors ?? []).map((error) => ({
        path: errorPath(error),
        message: error.message ?? 'invalid',
        code: error.keyword ?? 'schema_error',
      }))

  if (schemaName === 'task-contract' && typeof doc === 'object' && doc !== null) {
    const contract = /** @type {Record<string, any>} */ (doc)

    // Critério (3): superfícies e evidências de risco
    if (contract.risk && typeof contract.risk === 'object') {
      const surfaces = Array.isArray(contract.risk.surfaces) ? contract.risk.surfaces : []
      const evidence = Array.isArray(contract.risk.evidence) ? contract.risk.evidence : []

      // Validar identificadores canônicos de superfícies
      for (let i = 0; i < surfaces.length; i++) {
        const s = surfaces[i]
        if (!CANONICAL_SURFACES.has(s)) {
          const already = errors.some((e) => e.path.startsWith(`/risk/surfaces/${i}`))
          if (!already) {
            errors.push({
              path: `/risk/surfaces/${i}`,
              message: `superfície de risco desconhecida: ${s}`,
              code: 'unknown_risk_surface',
            })
          }
        }
      }

      // Validar formato de cada evidência como referência rastreável (prefixo:identificador)
      for (let i = 0; i < evidence.length; i++) {
        const ev = evidence[i]
        if (typeof ev !== 'string' || !TRACEABLE_REF_REGEX.test(ev.trim())) {
          const already = errors.some((e) => e.path.startsWith(`/risk/evidence/${i}`))
          if (!already) {
            errors.push({
              path: `/risk/evidence/${i}`,
              message: `evidência de risco deve ser referência rastreável (prefixo:identificador): "${ev}"`,
              code: 'invalid_risk_evidence',
            })
          }
        }
      }

      const hasSensitive = surfaces.some((/** @type {string} */ s) => SENSITIVE_SURFACES.has(s))
      if (hasSensitive) {
        if (contract.risk.level === 'light') {
          errors.push({
            path: '/risk/level',
            message: 'superfície sensível não pode declarar caminho leve (light)',
            code: 'sensitive_surface_light_path',
          })
        }
        const validEvidences = evidence.filter(
          (/** @type {any} */ ev) => typeof ev === 'string' && TRACEABLE_REF_REGEX.test(ev.trim()),
        )
        if (validEvidences.length === 0) {
          const already = errors.some((e) => e.path === '/risk/evidence')
          if (!already) {
            errors.push({
              path: '/risk/evidence',
              message: 'superfície sensível exige evidências rastreáveis',
              code: 'sensitive_surface_missing_evidence',
            })
          }
        }
      }
    }

    // Critério (2): verificadores declarados (lista superior não vazia, IDs presentes e únicos)
    const verifiersList = Array.isArray(contract.verifiers) ? contract.verifiers : []
    const evalsList = Array.isArray(contract.evals) ? contract.evals : []
    if (verifiersList.length === 0 && evalsList.length === 0) {
      const alreadyReported = errors.some((e) => e.path.startsWith('/verifiers'))
      if (!alreadyReported) {
        errors.push({
          path: '/verifiers',
          message: 'lista de verificadores não pode ser vazia',
          code: 'empty_verifiers',
        })
      }
    }

    const declaredVerifierIds = new Set()
    for (let i = 0; i < verifiersList.length; i++) {
      const v = verifiersList[i]
      if (!v || typeof v !== 'object') continue
      if (!v.id || typeof v.id !== 'string') {
        const already = errors.some((e) => e.path.startsWith(`/verifiers/${i}`))
        if (!already) {
          errors.push({
            path: `/verifiers/${i}/id`,
            message: 'verificador sem identificador (id) obrigatório',
            code: 'verifier_missing_id',
          })
        }
      } else if (declaredVerifierIds.has(v.id)) {
        errors.push({
          path: `/verifiers/${i}/id`,
          message: `identificador de verificador duplicado: ${v.id}`,
          code: 'duplicate_verifier_id',
        })
      } else {
        declaredVerifierIds.add(v.id)
      }
    }
    for (let i = 0; i < evalsList.length; i++) {
      const e = evalsList[i]
      if (e && typeof e === 'object') {
        if (typeof e.id === 'string') {
          declaredVerifierIds.add(e.id)
        }
        declaredVerifierIds.add(`E${i + 1}`)
      }
    }

    // Critério (2): verificador para cada cenário e correspondência com verificadores declarados
    if (Array.isArray(contract.scenarios)) {
      for (let i = 0; i < contract.scenarios.length; i++) {
        const sc = contract.scenarios[i]
        if (!sc || typeof sc !== 'object') continue
        const scVerifiers = Array.isArray(sc.verifiers) ? sc.verifiers : []
        const scEvals = Array.isArray(sc.evals) ? sc.evals : []
        if (scVerifiers.length === 0 && scEvals.length === 0) {
          const alreadyReported = errors.some((e) => e.path.startsWith(`/scenarios/${i}`))
          if (!alreadyReported) {
            errors.push({
              path: `/scenarios/${i}/verifiers`,
              message: 'cenário sem verificador obrigatório',
              code: 'scenario_without_verifier',
            })
          }
        } else {
          for (let j = 0; j < scVerifiers.length; j++) {
            const vId = scVerifiers[j]
            if (!declaredVerifierIds.has(vId)) {
              errors.push({
                path: `/scenarios/${i}/verifiers/${j}`,
                message: `verificador referenciado no cenário não existe em verifiers[]: ${vId}`,
                code: 'unresolved_verifier_reference',
              })
            }
          }
          for (let j = 0; j < scEvals.length; j++) {
            const eId = scEvals[j]
            if (!declaredVerifierIds.has(eId)) {
              errors.push({
                path: `/scenarios/${i}/evals/${j}`,
                message: `eval referenciado no cenário não existe: ${eId}`,
                code: 'unresolved_verifier_reference',
              })
            }
          }
        }
      }
    }
  }

  if (errors.length === 0) {
    return { valid: true, errors: [] }
  }

  return { valid: false, errors, code: 4 }
}

/**
 * Valida documentos suportados (versões legadas e correntes).
 *
 * @param {string} schemaName
 * @param {unknown} doc
 * @param {{ mode?: 'read' | 'approval', forApproval?: boolean }} [options]
 * @returns {{valid: true, errors: [], formatVersion: number, current: boolean} | {valid: false, errors: Array<{path: string, message: string, code?: string}>, code: 4, formatVersion: number | null, current: false}}
 */
export function validateSupported(schemaName, doc, options = {}) {
  const version =
    typeof doc === 'object' && doc !== null && typeof /** @type {any} */ (doc).format_version === 'number'
      ? /** @type {any} */ (doc).format_version
      : null

  const forApproval = options.mode === 'approval' || options.forApproval === true

  if (version === 1) {
    if (forApproval) {
      return {
        valid: false,
        errors: [
          {
            path: '/format_version',
            message:
              'formato legado obsoleto para nova aprovação; esperado formato corrente v0.3 (format_version 2).',
            code: 'obsolete_format',
          },
        ],
        code: 4,
        formatVersion: 1,
        current: false,
      }
    }

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
    const res = validate(schemaName, doc)

    if (res.valid) {
      return {
        valid: true,
        errors: [],
        formatVersion: 2,
        current: true,
      }
    }

    return {
      valid: false,
      errors: res.errors,
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
