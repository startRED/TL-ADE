/**
 * @typedef {Object} EvalItem
 * @property {string} [kind]
 * @property {{ mode?: string }} [strictness]
 */

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {EvalItem[]} [evals]
 */

/**
 * @typedef {Object} StrictnessValidationResult
 * @property {boolean} ok
 * @property {'additive_without_companion' | null} code
 * @property {string} scenario
 */

/**
 * Valida se um cenário com evals aditivos possui companheiro válido ('negative' ou 'mutate').
 *
 * @param {Scenario} scenario
 * @returns {StrictnessValidationResult}
 */
export function validateScenarioStrictness(scenario) {
  const evals = Array.isArray(scenario?.evals) ? scenario.evals : []

  /** @type {number[]} */
  const additiveIndices = []
  for (let i = 0; i < evals.length; i++) {
    if (evals[i]?.strictness?.mode === 'additive') {
      additiveIndices.push(i)
    }
  }

  if (additiveIndices.length === 0) {
    return {
      ok: true,
      code: null,
      scenario: scenario?.id,
    }
  }

  const allAdditiveHaveCompanion = additiveIndices.every((additiveIdx) =>
    evals.some(
      (candidate, idx) =>
        idx !== additiveIdx &&
        (candidate?.kind === 'negative' || candidate?.strictness?.mode === 'mutate')
    )
  )

  if (!allAdditiveHaveCompanion) {
    return {
      ok: false,
      code: 'additive_without_companion',
      scenario: scenario?.id,
    }
  }

  return {
    ok: true,
    code: null,
    scenario: scenario?.id,
  }
}
