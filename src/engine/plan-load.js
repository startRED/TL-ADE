// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { matchesGlob } from '../contain/contain.js'
import { digest16 } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'
import { validate } from '../schema/index.js'

export const EXTERNAL_EFFECTS = ['push', 'open_pr', 'merge']

export const INTERNAL_EFFECTS = [
  'prepare',
  'model_call',
  'local_write',
  'gate',
  'eval_run',
  'local_commit',
]

const EXPECTED_GATE_KEYS = ['id', 'argv', 'when', 'expect_exit', 'timeout_s']

/**
 * @typedef {Object} GateSpec
 * @property {string} id
 * @property {string[]} argv
 * @property {'always'} when
 * @property {number} expect_exit
 * @property {number} timeout_s
 */

/**
 * @typedef {Object} NormalizedEval
 * @property {string} id
 * @property {string} kind
 * @property {string[]} argv
 * @property {number} expect_exit
 * @property {number} timeout_s
 * @property {number} max_output_bytes
 * @property {{ mode: string }} strictness
 * @property {string[]} evidence
 * @property {number} [format_version]
 * @property {string} [author]
 */

/**
 * @typedef {Object} LoadedStory
 * @property {string} id
 * @property {Record<string, any>} contract
 * @property {string} spec_revision
 * @property {NormalizedEval[]} evals
 */

/**
 * @typedef {Object} LoadedPlan
 * @property {Record<string, any>} plan
 * @property {string} planDir
 * @property {{ max_usd: number, max_wall_clock_seconds: number, max_parked_units: number }} missionBudget
 * @property {GateSpec[]} gates
 * @property {LoadedStory[]} stories
 */

/**
 * Carrega e valida um plan.json, seus contratos e gates opcionais.
 *
 * @param {string} planPath
 * @returns {LoadedPlan}
 */
export function loadPlan(planPath) {
  let rawText
  try {
    rawText = fs.readFileSync(planPath, 'utf8')
  } catch {
    throw new AdeError('plan_unreadable', `plano ilegível: ${planPath}`, 4)
  }

  let doc
  try {
    doc = JSON.parse(rawText)
  } catch {
    throw new AdeError('plan_unreadable', `plano ilegível: ${planPath}`, 4)
  }

  const planValidation = validate('plan', doc)
  if (!planValidation.valid) {
    const details = planValidation.errors.map((e) => `${e.path} ${e.message}`).join('; ')
    throw new AdeError('plan_schema_invalid', `plano inválido: ${details}`, 4, {
      errors: planValidation.errors,
    })
  }

  const permitted = doc.authorization?.permitted_effects
  if (Array.isArray(permitted)) {
    for (const item of permitted) {
      if (INTERNAL_EFFECTS.includes(item)) {
        throw new AdeError(
          'internal_effect_declared',
          `classe interna não pode ser declarada em permitted_effects: ${item}`,
          4,
          { effect: item },
        )
      }
      if (!EXTERNAL_EFFECTS.includes(item)) {
        throw new AdeError('unknown_effect', `efeito desconhecido: ${item}`, 4, {
          effect: item,
        })
      }
    }
  }

  const planDir = path.resolve(path.dirname(planPath))

  // Leitura e validação de gates.json opcional
  const gatesPath = path.join(planDir, 'gates.json')
  /** @type {GateSpec[]} */
  let gates = []
  if (fs.existsSync(gatesPath)) {
    let gatesRaw
    try {
      gatesRaw = fs.readFileSync(gatesPath, 'utf8')
    } catch {
      throw new AdeError('gates_invalid', 'gates inválidos: JSON ilegível', 4)
    }

    let parsedGates
    try {
      parsedGates = JSON.parse(gatesRaw)
    } catch {
      throw new AdeError('gates_invalid', 'gates inválidos: JSON ilegível', 4)
    }

    if (!Array.isArray(parsedGates)) {
      throw new AdeError('gates_invalid', 'gates inválidos: não é array', 4)
    }

    for (let i = 0; i < parsedGates.length; i++) {
      const item = parsedGates[i]
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: item`, 4)
      }

      const itemKeys = Object.keys(item)
      for (const k of itemKeys) {
        if (!EXPECTED_GATE_KEYS.includes(k)) {
          throw new AdeError('gates_invalid', `gates inválidos: item ${i}: ${k}`, 4)
        }
      }
      for (const k of EXPECTED_GATE_KEYS) {
        if (!itemKeys.includes(k)) {
          throw new AdeError('gates_invalid', `gates inválidos: item ${i}: ${k}`, 4)
        }
      }

      if (typeof item.id !== 'string' || item.id.length === 0) {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: id`, 4)
      }
      if (
        !Array.isArray(item.argv) ||
        item.argv.length === 0 ||
        !item.argv.every((/** @type {any} */ a) => typeof a === 'string')
      ) {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: argv`, 4)
      }
      if (item.when !== 'always') {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: when`, 4)
      }
      if (typeof item.expect_exit !== 'number' || !Number.isInteger(item.expect_exit)) {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: expect_exit`, 4)
      }
      if (
        typeof item.timeout_s !== 'number' ||
        !Number.isInteger(item.timeout_s) ||
        item.timeout_s < 1
      ) {
        throw new AdeError('gates_invalid', `gates inválidos: item ${i}: timeout_s`, 4)
      }
    }

    gates = parsedGates
  }

  // Leitura e validação de cada story nos épicos
  /** @type {LoadedStory[]} */
  const stories = []
  for (const phase of doc.phases ?? []) {
    for (const epic of phase.epics ?? []) {
      for (const storyId of epic.stories ?? []) {
        const contractPath = path.join(planDir, 'stories', `${storyId}.json`)
        let contractRaw
        try {
          contractRaw = fs.readFileSync(contractPath, 'utf8')
        } catch {
          throw new AdeError('contract_missing', `contrato ausente: ${storyId}`, 4, {
            storyId,
            contractPath,
          })
        }

        let contract
        try {
          contract = JSON.parse(contractRaw)
        } catch {
          throw new AdeError(
            'contract_schema_invalid',
            `contrato inválido: ${storyId}: JSON ilegível`,
            4,
            { storyId },
          )
        }

        const contractValidation = validate('task-contract', contract)
        if (!contractValidation.valid) {
          const details = contractValidation.errors.map((e) => `${e.path} ${e.message}`).join('; ')
          throw new AdeError(
            'contract_schema_invalid',
            `contrato inválido: ${storyId}: ${details}`,
            4,
            { storyId, errors: contractValidation.errors },
          )
        }

        if (contract.id !== storyId) {
          throw new AdeError(
            'contract_id_mismatch',
            `id do contrato diverge da story: arquivo ${storyId}.json declara id ${contract.id}`,
            4,
            { storyId, contractId: contract.id },
          )
        }

        // Checagem de escopo dos evals
        const scopePaths = contract.guardrails?.scope_paths ?? []
        const evals = contract.evals ?? []
        for (let i = 0; i < evals.length; i++) {
          const evalItem = evals[i]
          const evalId = `E${i + 1}`
          /** @type {string[]} */
          const candidates = []

          if (Array.isArray(evalItem.cmd)) {
            for (const item of evalItem.cmd) {
              if (typeof item === 'string') {
                let val = item
                if (val.startsWith('-')) {
                  const eqIdx = val.indexOf('=')
                  if (eqIdx !== -1) {
                    val = val.slice(eqIdx + 1).replace(/^["']|["']$/g, '')
                  } else {
                    continue
                  }
                }
                const norm = val.replace(/\\/g, '/').replace(/^\.\//, '')
                if (!norm || norm.startsWith('-') || norm.startsWith('node_modules/')) {
                  continue
                }
                const hasSlash = norm.includes('/')
                const hasExt = path.extname(norm) !== '' && Number.isNaN(Number(norm))
                if (hasSlash || hasExt) {
                  candidates.push(norm)
                }
              }
            }
          }

          if (Array.isArray(evalItem.evidence)) {
            for (const item of evalItem.evidence) {
              if (typeof item === 'string') {
                const cut = item.split('::')[0]
                const norm = cut.replace(/\\/g, '/').replace(/^\.\//, '')
                if (norm.length > 0) {
                  candidates.push(norm)
                }
              }
            }
          }

          for (const cand of candidates) {
            const normalized = path.posix.normalize(cand)
            const isTraversal =
              normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)
            const inScope =
              !isTraversal && scopePaths.some((/** @type {string} */ p) => matchesGlob(p, normalized))
            if (!inScope) {
              throw new AdeError(
                'eval_outside_scope',
                `eval ${evalId} cita caminho fora de scope_paths: ${cand}`,
                4,
                { storyId, evalId, candidate: cand, normalized, scopePaths },
              )
            }
          }
        }

        let spec_revision
        try {
          spec_revision = digest16(contract)
        } catch (err) {
          throw new AdeError(
            'contract_canonicalization_failed',
            `contrato inválido: ${storyId}: falha na canonicalização (${err instanceof Error ? err.message : String(err)})`,
            4,
            { storyId, originalError: err instanceof Error ? err.message : String(err) },
          )
        }
        /** @type {any[]} */
        const rawEvals = Array.isArray(contract.evals) ? contract.evals : []
        const normalizedEvals = rawEvals.map((/** @type {any} */ e, /** @type {number} */ idx) => {
          const { cmd, ...rest } = e
          return {
            id: `E${idx + 1}`,
            ...rest,
            argv: cmd,
          }
        })

        stories.push({
          id: storyId,
          contract,
          spec_revision,
          evals: normalizedEvals,
        })
      }
    }
  }

  const missionBudget = {
    max_usd: doc.mission_budget.max_usd,
    max_wall_clock_seconds: doc.mission_budget.max_wall_clock_seconds ?? 28800,
    max_parked_units: doc.mission_budget.max_parked_units ?? 3,
  }

  return {
    plan: doc,
    planDir,
    missionBudget,
    gates,
    stories,
  }
}
