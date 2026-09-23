// Planejamento proporcional (lição de proto/planning.mjs): a quantidade de stories segue o
// trabalho, sem mínimo nem máximo; o que só o operador sabe vira decisão humana; a crítica
// do plano tenta outra empresa antes de desistir.

export type Issue = { story: string; problem: string }

export type PlanStory = {
  id?: string
  request?: string
  acceptance?: unknown[]
  scope_paths?: string[]
  depends_on?: string[]
  human_decision?: { reason: string }
}

export type PlanCritic = {
  family: string
  model: string
  critique: (plan: any) => Promise<any>
}

/** Dado que o motor não pode inventar: só o operador tem (conta, credencial, preço de verdade). */
const OPERATOR_ONLY_DATA =
  /\b(chaves? d[ae] (conta|api|acesso)|api keys?|pre[çc]os? rea(l|is)|credenciais? (rea(l|is)|de produ[çc][ãa]o|do operador)|senhas? rea(l|is)|n[úu]mero da conta|token de produ[çc][ãa]o)\b/i

/** Decisão humana exigida pelo texto do critério, ou null quando o motor pode decidir. */
export function humanDecisionOf(text: string): { reason: string } | null {
  const match = OPERATOR_ONLY_DATA.exec(text)
  return match ? { reason: `o critério exige "${match[0]}", dado que só o operador tem` } : null
}

/** Decisão humana da story: o dado só do operador pode estar no pedido ou em qualquer critério de aceite. */
export function storyHumanDecisionOf(contract: any): { reason: string } | null {
  const scenarios = (contract.scenarios || []).map((s: any) => `${s.given} ${s.when} ${s.then}`)
  return humanDecisionOf([contract.task, ...scenarios].join('\n'))
}

/** Stories do plano na forma de `planIssues`, com `human_decision` quando o briefing a registra. */
export function planStoriesOf(contracts: any[], humanDecisions: Record<string, { reason: string }> = {}): PlanStory[] {
  return contracts.map((c) => ({
    id: c.id,
    request: c.task,
    acceptance: c.scenarios,
    scope_paths: c.guardrails?.scope_paths,
    depends_on: c.depends_on,
    ...(humanDecisions[c.id] ? { human_decision: humanDecisions[c.id] } : {}),
  }))
}

/** Falhas estruturais do plano. Não há regra de contagem: uma story ou cinquenta. */
export function planIssues(plan: { stories?: PlanStory[] }): Issue[] {
  if (!Array.isArray(plan?.stories) || plan.stories.length === 0) return [{ story: '-', problem: 'Plano sem stories' }]
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const st of plan.stories) {
    const story = st.id || '-'
    if (!st.id || seen.has(st.id)) issues.push({ story, problem: 'ID de story ausente ou repetido' })
    if (!st.request?.trim()) issues.push({ story, problem: 'falta resultado pedido' })
    if (!st.acceptance?.length) issues.push({ story, problem: 'falta critério de aceite' })
    if (!st.scope_paths?.length) issues.push({ story, problem: 'falta scope_paths' })
    for (const dep of st.depends_on || []) {
      if (!seen.has(dep)) issues.push({ story, problem: `dependência ${dep} não existe antes desta story` })
    }
    if (st.human_decision && !st.human_decision.reason?.trim()) issues.push({ story, problem: 'decisão humana sem motivo' })
    if (st.id) seen.add(st.id)
  }
  return issues
}

/** Plano de alto risco pede a leitura de outra IA; detalhe local não justifica a chamada. */
export function needsPlanCritic(plan: any): boolean {
  const briefing = plan?.briefing ?? {}
  const domains: unknown[] = briefing.classification?.domains ?? []
  return briefing.risk?.level === 'critical' || domains.some((d) => d === 'security' || d === 'database')
}

/**
 * Crítica do plano com até duas empresas: a primária e, se ela falha, a primeira de outra
 * família. Cada falha fica em `attempts`; se as duas falham, o veredito é `failed`.
 */
export async function critiquePlan(plan: any, critics: PlanCritic[]): Promise<Record<string, any>> {
  const [primary] = critics
  if (!primary) throw new TypeError('critiquePlan: nenhum crítico configurado')
  const fallback = critics.find((c) => c.family !== primary.family)
  const attempts: Array<{ family: string; model: string; error: string }> = []
  for (const critic of fallback ? [primary, fallback] : [primary]) {
    let error: string
    try {
      const crit = await critic.critique(plan)
      if (crit && typeof crit.verdict === 'string') {
        return { ...crit, family: critic.family, model: critic.model, attempts }
      }
      error = 'resposta sem verdict'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    attempts.push({ family: critic.family, model: critic.model, error })
  }
  return { verdict: 'failed', attempts }
}

/** Motivos que impedem o plano de seguir sem `ade approve`; vazio quando nada pende. */
export function approvalReasons(plan: any): string[] {
  const reasons = Object.entries(plan?.briefing?.human_decisions || {}).map(
    ([id, decision]: [string, any]) => `${id}: ${decision.reason}`,
  )
  const critic = plan?.briefing?.plan_critic
  if (critic && critic.verdict !== 'ready') {
    reasons.push(
      critic.verdict === 'failed'
        ? `crítica do plano falhou em ${critic.attempts.map((a: any) => a.family).join(' e ')}`
        : `crítica do plano pediu revisão: ${critic.summary ?? ''}`.trim(),
    )
  }
  return reasons
}
