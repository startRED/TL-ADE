import { validate } from '../schema/index.ts'

/**
 * Valida o plano compilado e os contratos antes de qualquer aprovação.
 */
export function validateCompiledPlan(plan: any, contracts: any[] = []): { valid: boolean; errors: Array<{ path: string; message: string; code?: string }> } {
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
    if (contract.needs_ui) {
      if (!designBrief || typeof designBrief !== 'object') {
        errors.push({
          path: `/briefing/design_briefs/${contract.id}`,
          message: 'Contrato com needs_ui exige design_brief detalhado no briefing do plano',
          code: 'ui_missing_design_brief',
        })
      } else if (
        designBrief.direction &&
        (!designBrief.direction.self_critique ||
          typeof designBrief.direction.self_critique !== 'string' ||
          designBrief.direction.self_critique.trim() === '')
      ) {
        errors.push({
          path: `/briefing/design_briefs/${contract.id}/direction/self_critique`,
          message: 'DesignBrief exige self_critique preenchido na direção',
          code: 'ui_missing_self_critique',
        })
      }
    }

    // Regra adicional: todo verificador citado por cenário precisa existir no contrato
    const verifierIds = new Set((contract.verifiers || []).map((v: any) => v?.id))
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

    // Regra adicional: se depends_on estiver presente, cada story referenciada deve existir no plano
    if (Array.isArray(contract.depends_on)) {
      const allPlanStoryIds = new Set(
        contracts
          .map((c) => c?.id)
          .filter(Boolean)
          .concat(
            (plan.phases || []).flatMap((p: any) => (p.epics || []).flatMap((e: any) => e.stories || [])),
          ),
      )
      for (const dep of contract.depends_on) {
        if (!allPlanStoryIds.has(dep)) {
          errors.push({
            path: `/contracts/${i}/depends_on`,
            message: `Story ${contract.id} depende de story inexistente no plano: ${dep}`,
            code: 'missing_dependency',
          })
        }
      }
    }
  }

  // Detecção de ciclos no grafo de dependências
  const graph = new Map()
  for (const c of contracts) {
    if (c && typeof c.id === 'string') {
      graph.set(c.id, Array.isArray(c.depends_on) ? c.depends_on : [])
    }
  }

  const visitState = new Map()
  function hasCycle(node: string, stack: string[] = []): boolean {
    visitState.set(node, 1)
    stack.push(node)
    const neighbors = graph.get(node) || []
    for (const neighbor of neighbors) {
      if (!graph.has(neighbor)) continue
      const state = visitState.get(neighbor) || 0
      if (state === 1) {
        errors.push({
          path: '/contracts/depends_on',
          message: `Ciclo de dependências detectado: ${[...stack, neighbor].join(' -> ')}`,
          code: 'dependency_cycle',
        })
        return true
      }
      if (state === 0) {
        if (hasCycle(neighbor, stack)) return true
      }
    }
    stack.pop()
    visitState.set(node, 2)
    return false
  }

  for (const id of graph.keys()) {
    if ((visitState.get(id) || 0) === 0) {
      hasCycle(id)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
