// Planejamento proporcional (lição de proto/planning.mjs): a quantidade de stories segue o
// trabalho, sem mínimo nem máximo; o que só o operador sabe vira decisão humana; a crítica
// do plano tenta outra empresa antes de desistir.
import { digest16 } from '../journal/canonical.ts'

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
 * IDs das stories despacháveis declaradas pelo plano, na ordem do plano.
 * Tolera estrutura inválida (fase nula, épico nulo, story não-string): a travessia
 * nunca lança, e é o validador de schema que reporta as violações.
 */
export function storyIdsOf(plan: any): string[] {
  const phases = Array.isArray(plan?.phases) ? plan.phases : []
  return phases.flatMap((phase: any) => {
    const epics = Array.isArray(phase?.epics) ? phase.epics : []
    return epics.flatMap((epic: any) => {
      const stories = Array.isArray(epic?.stories) ? epic.stories : []
      return stories.filter((id: any) => typeof id === 'string' && id !== '')
    })
  })
}

/** Digest das stories do plano: a crítica que leu outras stories está desatualizada. */
export function planStoriesDigest(plan: any): string {
  return digest16(storyIdsOf(plan))
}

/** Crítica gravada que não leu as stories atuais do plano. */
export function planCriticStale(plan: any): boolean {
  const critic = plan?.briefing?.plan_critic
  return Boolean(critic) && critic.plan_digest !== planStoriesDigest(plan)
}

/** Palavras com peso de um texto, sem acento nem caixa. */
function wordsOf(text: string): string[] {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3)
}

/**
 * Critérios do épico que nenhum texto entrega: coberto é o critério cujas palavras aparecem
 * todas num mesmo texto (story ou issue 'novo' do crítico).
 * ponytail: casamento por palavra inteira; flexão diferente ("mostra"/"mostrar") conta como falta.
 */
function uncoveredCriteria(criteria: string[], texts: string[]): string[] {
  const bags = texts.map((t) => new Set(wordsOf(t)))
  return criteria.filter((c) => !bags.some((bag) => wordsOf(c).every((w) => bag.has(w))))
}

/**
 * Crítica do plano com até duas empresas: a primária e, se ela falha, a primeira de outra
 * família. Cada falha fica em `attempts`; se as duas falham, o veredito é `failed`. O digest
 * das stories lidas vai junto, e critério do épico sem story vira issue 'novo' com 'revise'
 * mesmo quando o crítico disse 'ready' (lição de proto/server.mjs planCritic).
 */
export async function critiquePlan(
  input: { plan: any; contracts: any[] },
  critics: PlanCritic[],
  { epicAcceptance = [] }: { epicAcceptance?: string[] } = {},
): Promise<Record<string, any>> {
  const [primary] = critics
  const plan_digest = planStoriesDigest(input.plan)
  // Sem crítico não há tentativa: a crítica sai 'failed' e o plano não segue sem aprovação.
  if (!primary) return { verdict: 'failed', attempts: [], plan_digest }
  const fallback = critics.find((c) => c.family !== primary.family)
  const attempts: Array<{ family: string; model: string; error: string }> = []
  for (const critic of fallback ? [primary, fallback] : [primary]) {
    let error: string
    try {
      const crit = await critic.critique({ ...input, epicAcceptance })
      if (crit && typeof crit.verdict === 'string') {
        const issues: any[] = Array.isArray(crit.issues) ? crit.issues : []
        const texts = [
          ...input.contracts.map((c) => [c.task, ...(c.scenarios ?? []).map((s: any) => `${s.given} ${s.when} ${s.then}`)].join(' ')),
          ...issues.filter((i) => i.story === 'novo').map((i) => `${i.problem} ${i.fix}`),
        ]
        const missing = uncoveredCriteria(epicAcceptance, texts).map((c) => ({
          story: 'novo',
          problem: `nenhuma story entrega o critério do épico "${c}"`,
          fix: `Criar story que entregue o critério do épico: ${c}`,
        }))
        const all = [...issues, ...missing]
        const verdict = all.some((i) => i.story === 'novo') ? 'revise' : crit.verdict
        return { ...crit, verdict, issues: all, family: critic.family, model: critic.model, attempts, plan_digest }
      }
      error = 'resposta sem verdict'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    attempts.push({ family: critic.family, model: critic.model, error })
  }
  return { verdict: 'failed', attempts, plan_digest }
}

/** Motivos que impedem o plano de seguir sem `ade approve`; vazio quando nada pende. */
export function approvalReasons(plan: any): string[] {
  const reasons = Object.entries(plan?.briefing?.human_decisions || {}).map(
    ([id, decision]: [string, any]) => `${id}: ${decision.reason}`,
  )
  // Plano nascido de briefing de produto nunca segue sem aprovação (lição de proto/server.mjs).
  const product = plan?.briefing?.product
  if (product) {
    reasons.push(`plano da versão ${product.versions?.[plan.briefing.version_index]?.name ?? '?'} do briefing "${product.title}" exige aprovação`)
  }
  const critic = plan?.briefing?.plan_critic
  if (planCriticStale(plan)) {
    reasons.push(`crítica desatualizada: as stories mudaram depois dela; rode ade plan --mission ${plan.mission_id} --recritique`)
  }
  // Crítica nova de plano corrigido não aprova sozinha: a correção mudou o plano.
  if (critic?.revalidated) reasons.push('plano corrigido exige aprovação')
  if (critic && critic.verdict !== 'ready') {
    reasons.push(
      critic.verdict === 'failed'
        ? critic.attempts.length > 0
          ? `crítica do plano falhou em ${critic.attempts.map((a: any) => a.family).join(' e ')}`
          : `crítica do plano falhou: nenhum crítico disponível; rode ade plan --mission ${plan.mission_id} --recritique`
        : `crítica do plano pediu revisão: ${critic.summary ?? ''}`.trim(),
    )
  }
  return reasons
}
