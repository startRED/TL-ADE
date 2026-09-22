// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { matchesGlob } from '../contain/contain.js'
import { digest16 } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'
import { validate, validateSupported } from '../schema/index.js'
import { assertCallBudget } from './budget.js'

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
 * @property {{ max_usd: number, max_wall_clock_seconds: number, max_parked_units: number, max_subscription_weekly_percent: number }} missionBudget
 * @property {GateSpec[]} gates
 * @property {LoadedStory[]} stories
 * @property {number} [lineageCallsRemaining]
 */

/**
 * Retorna o orçamento padrão de modelo e correções por complexidade e presença de UI.
 *
 * @param {{ complexity: string, needs_ui?: boolean }} params
 * @returns {{ max_model_calls: number, max_rework_rounds: number }}
 */
export function defaultStoryBudget({ complexity, needs_ui = false }) {
  if (complexity === 'trivial') {
    return { max_model_calls: 3, max_rework_rounds: 1 }
  }
  if (complexity === 'bounded') {
    return needs_ui
      ? { max_model_calls: 8, max_rework_rounds: 3 }
      : { max_model_calls: 6, max_rework_rounds: 2 }
  }
  if (complexity === 'feature') {
    return needs_ui
      ? { max_model_calls: 12, max_rework_rounds: 3 }
      : { max_model_calls: 10, max_rework_rounds: 3 }
  }
  if (complexity === 'subsystem' || complexity === 'project') {
    return { max_model_calls: 12, max_rework_rounds: 3 }
  }
  throw new AdeError('unknown_complexity', `complexidade desconhecida: ${complexity}`, 4)
}

/**
 * Carrega e valida um plan.json, seus contratos e gates opcionais.
 * O modo 'read' existe para leitura e inspeção de planos históricos em formatos legados
 * (ainda sem chamador de produção na v0.3, usado para validação e leitura não-bloqueante).
 *
 * @param {string | Record<string, any>} planPath
 * @param {{ mode?: 'read' | 'approval' }} [options]
 * @returns {LoadedPlan}
 */
export function loadPlan(planPath, options = {}) {
  let doc
  let planDir
  const mode = options?.mode ?? 'approval'

  if (typeof planPath === 'object' && planPath !== null) {
    doc = planPath
    planDir = process.cwd()
  } else {
    let rawText
    try {
      rawText = fs.readFileSync(planPath, 'utf8')
    } catch {
      throw new AdeError('plan_unreadable', `plano ilegível: ${planPath}`, 4)
    }

    try {
      doc = JSON.parse(rawText)
    } catch {
      throw new AdeError('plan_unreadable', `plano ilegível: ${planPath}`, 4)
    }
    planDir = path.resolve(path.dirname(planPath))
  }

  // Rejeitar mission_budget.max_usd acima de 300 ou negativo
  if (doc && typeof doc === 'object' && doc.mission_budget) {
    const maxUsd = doc.mission_budget.max_usd
    if (
      maxUsd !== undefined &&
      (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd > 300 || maxUsd < 0)
    ) {
      throw new AdeError(
        'budget_usd_above_absolute_cap',
        `orçamento max_usd (${maxUsd}) inválido ou acima do teto absoluto de US$ 300`,
        4,
        { max_usd: maxUsd },
      )
    }
  }

  // Rejeitar efeitos não booleanos ou não autorizados antes de despacho
  if (doc && typeof doc === 'object') {
    /**
     * @param {string} k
     * @param {unknown} v
     */
    const checkEffectEntry = (k, v) => {
      if (typeof v !== 'boolean') {
        throw new AdeError('invalid_effect_value', `efeito não booleano: ${k}`, 4, { effect: k, value: v })
      }
      if (!EXTERNAL_EFFECTS.includes(k)) {
        throw new AdeError('unauthorized_effect', `efeito externo não autorizado: ${k}`, 4, { effect: k })
      }
    }

    for (const eff of ['push', 'open_pr', 'merge']) {
      if (eff in doc) {
        checkEffectEntry(eff, doc[eff])
      }
    }

    for (const k of Object.keys(doc)) {
      if (
        ![
          'format_version',
          'id',
          'mission_id',
          'immutable_digest',
          'authorization',
          'phases',
          'mission_budget',
          'budget',
          'direction',
          'next_delivery',
          'intent',
          'briefing',
          'unknowns',
          'push',
          'open_pr',
          'merge',
        ].includes(k)
      ) {
        if (typeof doc[k] === 'boolean' || doc[k] === 'true' || doc[k] === 'false') {
          checkEffectEntry(k, doc[k])
        }
      }
    }

    if (doc.effects && typeof doc.effects === 'object' && !Array.isArray(doc.effects)) {
      for (const [k, v] of Object.entries(doc.effects)) {
        checkEffectEntry(k, v)
      }
    }
  }

  if (mode === 'read') {
    const supportedRes = validateSupported('plan', doc)
    if (!supportedRes.valid) {
      const details = supportedRes.errors.map((e) => `${e.path} ${e.message}`).join('; ')
      throw new AdeError('plan_schema_invalid', `plano inválido: ${details}`, 4, {
        errors: supportedRes.errors,
      })
    }
  } else {
    if (doc && typeof doc === 'object' && doc.format_version === 1) {
      throw new AdeError(
        'plan_obsolete',
        'formato legado obsoleto para nova aprovação/execução; esperado formato corrente v0.3 (format_version 2)',
        4,
        { format_version: 1 },
      )
    }

    const planValidation = validate('plan', doc)
    if (!planValidation.valid) {
      const details = planValidation.errors.map((e) => `${e.path} ${e.message}`).join('; ')
      throw new AdeError('plan_schema_invalid', `plano inválido: ${details}`, 4, {
        errors: planValidation.errors,
      })
    }
  }

  assertCallBudget(doc.budget, 'plan')

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

  if (typeof planPath === 'string') {
    planDir = path.resolve(path.dirname(planPath))
  }

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

        if (mode === 'read') {
          const contractValidation = validateSupported('task-contract', contract)
          if (!contractValidation.valid) {
            const details = contractValidation.errors.map((e) => `${e.path} ${e.message}`).join('; ')
            throw new AdeError(
              'contract_schema_invalid',
              `contrato inválido: ${storyId}: ${details}`,
              4,
              { storyId, errors: contractValidation.errors },
            )
          }
        } else {
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
        }

        contract.needs_ui = contract.needs_ui ?? false
        const defaultBudget = defaultStoryBudget({
          complexity: contract.complexity,
          needs_ui: contract.needs_ui,
        })
        contract.budget = contract.budget ?? {}
        if (contract.budget.max_model_calls === undefined) {
          contract.budget.max_model_calls = defaultBudget.max_model_calls
        }
        if (contract.budget.max_rework_rounds === undefined) {
          contract.budget.max_rework_rounds = defaultBudget.max_rework_rounds
        }

        assertCallBudget(contract.budget, 'contract')

        if (contract.id !== storyId) {
          throw new AdeError(
            'contract_id_mismatch',
            `id do contrato diverge da story: arquivo ${storyId}.json declara id ${contract.id}`,
            4,
            { storyId, contractId: contract.id },
          )
        }

        // Checagem de escopo dos evals / verifiers
        const scopePaths = contract.guardrails?.scope_paths ?? []
        const verifiersList = [
          ...(Array.isArray(contract.evals) && contract.evals.length > 0 ? contract.evals : []),
          ...(Array.isArray(contract.verifiers) ? contract.verifiers : []),
        ]
        for (let i = 0; i < verifiersList.length; i++) {
          const evalItem = verifiersList[i]
          const evalId = evalItem.id || `E${i + 1}`
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
        const rawEvals = Array.isArray(contract.evals) && contract.evals.length > 0
          ? contract.evals
          : (Array.isArray(contract.verifiers) ? contract.verifiers : [])
        const normalizedEvals = rawEvals.map((/** @type {any} */ e, /** @type {number} */ idx) => {
          const { cmd, ...rest } = e
          const id = e.id || `E${idx + 1}`
          if (e.kind === 'script' || (e.kind === undefined && Array.isArray(cmd))) {
            if (!Array.isArray(cmd) || cmd.length === 0) {
              throw new AdeError(
                'contract_invalid',
                `contrato inválido: ${storyId}: verificador ${id} da classe script sem comando`,
                4,
                { storyId, evalId: id },
              )
            }
            return {
              id,
              ...rest,
              argv: cmd,
            }
          }
          return {
            id,
            ...rest,
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
    max_subscription_weekly_percent: doc.mission_budget.max_subscription_weekly_percent ?? 50,
  }

  return {
    plan: doc,
    planDir,
    missionBudget,
    gates,
    stories,
  }
}
