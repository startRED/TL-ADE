interface EvalItem {
  kind?: string
  strictness?: { mode?: string} 
}

interface Scenario {
  id: string
  evals?: EvalItem[]
}

interface StrictnessValidationResult {
  ok: boolean
  code: 'additive_without_companion' | null
  scenario: string
}

/**
 * Valida se um cenário com evals aditivos possui companheiro válido ('negative' ou 'mutate').
 */
export function validateScenarioStrictness(scenario: Scenario): StrictnessValidationResult {
  const evals = Array.isArray(scenario?.evals) ? scenario.evals : []

  
  const additiveIndices: number[] = []
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
