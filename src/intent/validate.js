import { validate } from '../schema/index.js'

/**
 * Valida o plano compilado e os contratos antes de qualquer aprovação.
 *
 * @param {any} plan
 * @param {any[]} [contracts]
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string, code?: string }> }}
 */
export function validateCompiledPlan(plan, contracts = []) {
  const errors = []

  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      errors: [{ path: '/', message: 'Plano inválido ou ausente', code: 'missing_plan' }],
    }
  }

  const planRes = validate('plan', plan)
  if (!planRes.valid) {
    errors.push(...planRes.errors)
  }

  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i]
    if (!contract || typeof contract !== 'object') {
      errors.push({ path: `/contracts/${i}`, message: 'Contrato inválido', code: 'invalid_contract' })
      continue
    }

    const contractRes = validate('task-contract', contract)
    if (!contractRes.valid) {
      errors.push(...contractRes.errors)
    }

    // Regra adicional: se needs_ui === true, o plano deve trazer o briefing de design da story
    // (o schema do contrato é fechado, então o briefing vive em plan.briefing.design_briefs)
    const designBrief = plan.briefing?.design_briefs?.[contract.id]
    if (contract.needs_ui && (!designBrief || typeof designBrief !== 'object')) {
      errors.push({
        path: `/briefing/design_briefs/${contract.id}`,
        message: 'Contrato com needs_ui exige design_brief detalhado no briefing do plano',
        code: 'ui_missing_design_brief',
      })
    }

    // Regra adicional: todo verificador citado por cenário precisa existir no contrato
    const verifierIds = new Set((contract.verifiers || []).map((v) => v?.id))
    for (const scenario of contract.scenarios || []) {
      for (const ref of scenario?.verifiers || []) {
        if (!verifierIds.has(ref)) {
          errors.push({
            path: `/contracts/${i}/scenarios/${scenario.id}/verifiers`,
            message: `Cenário ${scenario.id} referencia verificador inexistente: ${ref}`,
            code: 'scenario_verifier_missing',
          })
        }
      }
    }

    // Regra adicional: validação de requisitos EARS não-genéricos
    if (Array.isArray(contract.requirements)) {
      for (let j = 0; j < contract.requirements.length; j++) {
        const req = contract.requirements[j]
        if (!req || typeof req !== 'object') continue
        const ears = (req.ears || '').trim()
        const lower = ears.toLowerCase()
        const upper = ears.toUpperCase()
        const isGeneric =
          lower.includes('work correctly') ||
          lower.includes('funcionar corretamente') ||
          lower.includes('work properly')
        const hasTrigger =
          upper.includes('WHEN') ||
          upper.includes('WHILE') ||
          upper.includes('WHERE') ||
          upper.includes('IF')

        if (isGeneric || (!hasTrigger && (lower.includes('correct') || lower.includes('properly')))) {
          errors.push({
            path: `/contracts/${i}/requirements/${j}/ears`,
            message: `Requisito genérico rejeitado: "${ears}"`,
            code: 'ears_form_rejected',
          })
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
