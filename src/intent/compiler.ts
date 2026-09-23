import { createHash } from 'node:crypto'
import { classifyIntent } from './classify.ts'
import { assessRisk } from './risk.ts'
import { generateBriefing } from './briefing.ts'
import { buildInterview, applyInterviewAnswer, getRefusedQuestions, type Decision } from './interview.ts'
import { runResearchStep, fallbackArtifact } from './research.ts'
import { selectEligibleSkills } from './skills.ts'
import { splitContract } from './split.ts'
import { validateCompiledPlan } from './validate.ts'
import { planStoriesOf, storyHumanDecisionOf, type PlanStory } from './proportional.ts'
import { discoverDesignSignals } from '../visual/design-discovery.ts'
import { buildDesignBrief } from '../visual/design-brief.ts'

export {
  classifyIntent,
  buildInterview,
  applyInterviewAnswer,
  runResearchStep,
  fallbackArtifact,
  selectEligibleSkills,
  splitContract,
  validateCompiledPlan,
  discoverDesignSignals,
  buildDesignBrief,
}

/**
 * Quebra o pedido nas entregas que ele enumera (vírgulas e conectivo "e").
 */
function splitDeliverables(request: string): string[] {
  return request
    .split(/,| e /i)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
}

function buildVerifiers({ risk, discovery }: { risk: any; discovery: any }) {
  const testCmd = discovery.scripts?.test
    ? discovery.scripts.test.split(' ')
    : ['node', 'node_modules/vitest/vitest.mjs', 'run']
  const anchorPaths = (discovery.anchors || []).map((a: any) => a.path)
  const evidence = anchorPaths.length > 0 ? anchorPaths : ['package.json']

  const base = {
    id: 'V1',
    kind: 'script',
    cmd: testCmd,
    expect_exit: 0,
    timeout_s: 30,
    max_output_bytes: 1024,
    evidence,
    strictness: { mode: 'must_fail_before' },
    author: 'operator',
  }

  if (risk.level !== 'critical') return [base]

  const surface = risk.surfaces[0]
  const surfaceEvidence = risk.sensitive_paths?.length > 0 ? risk.sensitive_paths : evidence

  return [
    base,
    {
      id: `V2-neg-${surface}`,
      kind: 'script',
      cmd: [...testCmd, '-t', `${surface} negativo`],
      expect_exit: 0,
      timeout_s: 30,
      max_output_bytes: 1024,
      evidence: surfaceEvidence,
      strictness: { mode: 'must_fail_before' },
      author: 'operator',
      description: `Verificador negativo da superfície crítica ${surface}: credencial inválida ou expirada deve ser recusada e o acesso anterior revogado (recuperação), falhando antes da mudança em ${surfaceEvidence.join(', ')}`,
    },
  ]
}

/**
 * Cenário negativo correspondente ao verificador de recuperação da superfície crítica.
 */
function criticalScenario({ n, risk, verifiers }: { n: number; risk: any; verifiers: any[] }) {
  const surface = risk.surfaces[0]
  const negative = verifiers.filter((v) => v.id.startsWith('V2-neg-'))
  if (negative.length === 0) return []
  return [
    {
      id: `C${n}-neg`,
      given: `um acesso inválido ou expirado na superfície crítica ${surface}`,
      when: 'a mudança é aplicada e o verificador negativo é executado',
      then: `o acesso é recusado e o estado anterior de ${surface} é recuperado`,
      verifiers: negative.map((v) => v.id),
    },
  ]
}

function buildContract({
  id,
  title,
  task,
  complexity,
  needsUi,
  risk,
  guardrails,
  verifiers,
  skills,
  discovery,
  index,
  unknowns = ([] as any[]),
  researchRefs = ([] as string[]),
}: Record<string, any> & { verifiers: any[] }) {
  const n = index + 1
  return {
    format_version: 2,
    id,
    title: title.slice(0, 80),
    complexity,
    needs_ui: needsUi,
    task,
    workspace: { kind: 'git', root: '.', revision: discovery.repo?.head || 'HEAD' },
    risk: { level: risk.level, surfaces: risk.surfaces, evidence: risk.evidence },
    guardrails,
    requirements: [
      {
        id: `R${n}`,
        ears: `WHEN the operator triggers "${task.slice(0, 60).replace(/\r?\n|"/g, ' ')}" THE SYSTEM SHALL complete it and report success within 30 s`,
      },
    ],
    scenarios: [
      {
        id: `C${n}`,
        given: 'ambiente preparado pelo discovery',
        when: `a entrega "${task.slice(0, 60).replace(/\r?\n|"/g, ' ')}" é executada`,
        then: 'o resultado é concluído e verificado',
        verifiers: verifiers.filter((v) => !v.id.startsWith('V2-neg-')).map((v) => v.id),
      },
      ...criticalScenario({ n, risk, verifiers }),
    ],
    verifiers,
    skills,
    roles: {
      maker: { family: 'claude', model_id: 'claude-opus-5-5' }, // 22/09: Terminal-Bench 4.0 66% contra 52% do Opus 5, US$ 4/20
      checker_round: { family: 'codex', model_id: 'codex-1' },
    },
    budget: { max_model_calls: 3, max_rework_rounds: 1 },
    unknowns,
    research_refs: researchRefs,
  }
}

/** Id da missão derivado do pedido: o mesmo pedido cai na mesma pasta de missão. */
export function missionIdOf(request: string): string {
  return `mission-${createHash('sha256').update(request).digest('hex').slice(0, 12)}`
}

/** Decisão 'ia_supondo' de uma incógnita externa resolvida por pesquisa ou fallback. */
function researchDecisionOf(unknown: any, artifact: any): Decision {
  const data = artifact.data || {}
  return {
    unknown_id: String(unknown.id),
    value: String(data.default_value ?? data.result ?? artifact.ref),
    origin: 'ia_supondo',
    rationale: String(data.rationale ?? `pesquisa: ${artifact.ref}`),
  }
}

/**
 * Compila pedidos em briefing, classificação, entrevista e plano progressivo executável,
 * integrando pesquisa externa controlada com tetos por classe de complexidade e fallback seguro.
 */
export async function compileIntent({
  request = '',
  discovery = {},
  repoIr = {},
  eligibleSkills = [],
  advisor,
  unknowns = [],
  policy = {},
  researcher,
  adeConfig,
  budget = {},
  interview,
  decisions = [],
}: {
        request: string
        discovery?: any
        repoIr?: any
        eligibleSkills?: any[]
        policy?: any
        advisor?: Function
        unknowns?: any[]
        researcher?: Function
        adeConfig?: any
        budget?: any
        /** Perguntas já gravadas na missão suspensa; quando presentes, a entrevista não é refeita. */
        interview?: any[]
        /** Decisões da entrevista já respondida: orientam as tarefas dos contratos e abrem o briefing. */
        decisions?: Decision[]
    }): Promise<{ briefing: any; plan: any; contracts: any[]; stories: PlanStory[]; questions: any[]; refusedQuestions: any[] }> {
  if (typeof request !== 'string' || request.trim() === '') {
    throw new TypeError('compileIntent: request é obrigatório')
  }

  const classification = await classifyIntent({ request, discovery, repoIr }, advisor)
  const risk = assessRisk({ request, discovery, classification })
  const briefing = generateBriefing({ request, discovery, classification, risk })

  const questions = interview ? [...interview] : buildInterview({ unknowns, discovery, repoIr, maxQuestions: 5 })
  const refusedQuestions = getRefusedQuestions({ unknowns, discovery, repoIr })
  // Dúvidas resolvidas sem perguntar ao operador: fato do repositório, pesquisa ou fallback.
  const aiDecisions: Decision[] = []
  for (const refused of refusedQuestions) {
    const u = unknowns.find((x) => x?.id && (x.question || x.text) === refused.question)
    if (u) {
      aiDecisions.push({ unknown_id: String(u.id), value: refused.evidence, origin: 'ia_supondo', rationale: `fato já respondido pelo projeto: ${refused.evidence}` })
    }
  }

  const complexity = classification.complexity
  const externalUnknowns = unknowns.filter((u) => u && u.kind === 'external_fact')

  // Tetos normativos de pesquisa por complexidade:
  // - trivial: 0 consultas (pesquisa proibida)
  // - bounded: máximo 1 consulta, sem time paralelo
  // - feature ou superior: até 3 consultas
  let maxQueries = 0
  if (complexity === 'bounded') {
    maxQueries = 1
  } else if (['feature', 'subsystem', 'project'].includes(complexity)) {
    maxQueries = 3
  }

  const allowResearch =
    policy.allow_research !== false &&
    adeConfig?.research?.enabled !== false &&
    complexity !== 'trivial'
  const configuredMaxQueries = adeConfig?.research?.max_queries
  const effectiveMaxQueries = allowResearch
    ? Math.min(maxQueries, Number.isSafeInteger(configuredMaxQueries) ? configuredMaxQueries : maxQueries)
    : 0

  const teamEnabled =
    (complexity === 'subsystem' || complexity === 'project') &&
    (policy.team_enabled === true || adeConfig?.research?.team_enabled === true)
  const teamSize = policy.team_size ?? adeConfig?.research?.team_size
  if (teamEnabled && (!Number.isSafeInteger(teamSize) || teamSize < 2 || teamSize > 4)) {
    throw new TypeError('compileIntent: time de pesquisa exige team_size entre 2 e 4')
  }

  const configuredMaxUsd = adeConfig?.research?.max_usd
  const budgetMaxUsd = budget.max_usd
  const maxResearchUsd = Math.min(
    typeof configuredMaxUsd === 'number' ? configuredMaxUsd : Number.POSITIVE_INFINITY,
    typeof budgetMaxUsd === 'number' ? budgetMaxUsd : Number.POSITIVE_INFINITY,
  )

  
  const researchFindings: any[] = []
  
  const researchFallbacks: any[] = []
  const contractUnknowns = unknowns.map((u) => {
    const rawKind = u.kind || 'product_choice'
    const kind = ['product_choice', 'external_fact', 'repo_fact'].includes(rawKind) ? rawKind : 'product_choice'
    
    const base: any = {
      id: String(u.id || ''),
      question: String(u.question || ''),
      kind,
    }
    if (u.resolved_by) {
      base.resolved_by = String(u.resolved_by)
    }
    return base
  })

  let researchCostUsd = 0
  let divergenceDetected = false

  for (let i = 0; i < externalUnknowns.length; i++) {
    const extU = externalUnknowns[i]
    const unknownInContract = contractUnknowns.find((u) => u.id === extU.id)

    const consumedUsd = (budget.consumed_usd ?? 0) + researchCostUsd
    const hasBudget = consumedUsd < maxResearchUsd
    if (i < effectiveMaxQueries && hasBudget && typeof researcher === 'function') {
      const stepRes = await runResearchStep({
        unknown: extU,
        budget: {
          ...budget,
          ...(Number.isFinite(maxResearchUsd) ? { max_usd: maxResearchUsd } : {}),
          consumed_usd: consumedUsd,
        },
        researcher,
        policy: { ...policy, team_enabled: teamEnabled, team_size: teamSize },
      })

      if (stepRes?.divergent) {
        divergenceDetected = true
        questions.push(({
          id: `Q-divergence-${extU.id}`,
          text: stepRes.question || `Divergência de pesquisa em "${extU.question}"`,
          question: extU.question,
          kind: 'divergence',
          options: (stepRes.findings || []).map((f: any) => ({
            id: f.id,
            label: `${f.source}: ${f.result || f.claims?.[0]?.text || ''}`,
          })),
        } as any))
        if (unknownInContract) {
          unknownInContract.resolved_by = 'awaiting_operator'
        }
      } else if (stepRes?.kind === 'research_finding') {
        ;(stepRes.data?.fallback_applied || stepRes.data?.parked ? researchFallbacks : researchFindings).push(stepRes)
        if (typeof stepRes.data?.cost === 'number') {
          researchCostUsd += stepRes.data.cost
        }
        if (unknownInContract) {
          if (stepRes.data?.parked) {
            unknownInContract.parked = true
            unknownInContract.resolved_by = 'parked'
          } else if (stepRes.data?.fallback_applied) {
            unknownInContract.resolved_by = 'fallback_assumed'
          } else {
            unknownInContract.resolved_by = 'research'
          }
        }
        if (!stepRes.data?.parked) aiDecisions.push(researchDecisionOf(extU, stepRes))
      }
    } else {
      // Excedeu o teto ou pesquisa desabilitada/não autorizada
      if (complexity !== 'trivial') {
        const fallback = fallbackArtifact({
          unknown: extU,
          budget,
          reason: !hasBudget
            ? 'Orçamento de pesquisa esgotado'
            : allowResearch
            ? `Limite de pesquisa para ${complexity} atingido (máximo ${maxQueries} consulta${maxQueries > 1 ? 's' : ''})`
            : 'Pesquisa desabilitada por política',
          fallbackAuthorized: policy.fallback_authorized !== false && hasBudget,
        })
        researchFallbacks.push(fallback)
        if (unknownInContract) {
          if (fallback.data?.parked) {
            unknownInContract.parked = true
            unknownInContract.resolved_by = 'parked'
          } else {
            unknownInContract.resolved_by = 'fallback_assumed'
          }
        }
        if (!fallback.data?.parked) aiDecisions.push(researchDecisionOf(extU, fallback))
      }
    }
  }

  const verifiers = buildVerifiers({ risk, discovery })
  const verifierEvidence = verifiers.flatMap((v) => v.evidence || [])
  const baseScopePaths = risk.sensitive_paths
    ? risk.sensitive_paths
    : (discovery.anchors || []).length > 0
      ? discovery.anchors.map((a: any) => a.path)
      : ['src/**']

  const guardrails = {
    scope_paths: Array.from(new Set([...baseScopePaths, ...verifierEvidence])),
    do_not_touch: ['.ade/**', 'docs/specs/frontend-quality-engine.md', 'proto/**'],
    autonomy: 'safe',
    ...(risk.sensitive_paths ? { sensitive_paths: risk.sensitive_paths } : {}),
    ...(risk.ask_operator
      ? {
          ask_operator: [
            ...risk.ask_operator,
            `Autorizar a alteração da superfície crítica ${risk.surfaces.join(', ')} antes de executar a story`,
          ],
        }
      : {}),
  }

  const designSignals = discoverDesignSignals({
    request,
    paths: (discovery.modules || []).map((/** */ m: any) => m.path),
    packageJson: discovery.packageJson,
    scopePaths: (discovery.anchors || []).map((a: any) => a.path),
  })

  const needsUi = Boolean(
    discovery.ui?.present ||
      designSignals.has_ui ||
      /bot[ãa]o|ui|tela|interface|design|frontend|responsiv[oa]/i.test(request),
  )

  const skills = selectEligibleSkills({
    story: {
      domains: classification.domains || (risk.surfaces.includes('auth') ? ['security', 'auth'] : ['backend']),
      languages: (discovery.languages || []).map((l: any) => l.name),
      task: request,
    },
    eligibleSkills,
  })

  // A quantidade de stories segue as entregas do pedido, sem mínimo nem máximo fixos.
  const deliverables = splitDeliverables(request)
  const immediate = deliverables.length > 1 ? deliverables : [request]

  const researchRefs = researchFindings.map((f) => f.ref)

  // As escolhas da entrevista chegam a quem executa pela tarefa do contrato (o schema é fechado).
  const choices = decisions.map((d) => {
    const q = questions.find((x) => x.id === d.question_id)
    const option = q?.options?.find((o: any) => o.id === d.value)
    return `${q?.text ?? d.question_id} → ${option?.label ?? d.value}`
  })
  const taskOf = (deliverable: string) =>
    choices.length > 0 ? `${deliverable}\nDecisões da entrevista: ${choices.join('; ')}` : deliverable

  const contracts = immediate.map((deliverable, index) => {
    const idMatch = deliverable.match(/^(S\d+)\b/i)
    const id = idMatch ? idMatch[1].toUpperCase() : `S${index + 1}`
    const num = id.replace(/\D/g, '') || String(index + 1)
    const c = buildContract({
      id,
      title: deliverable,
      task: taskOf(deliverable),
      complexity: classification.complexity,
      needsUi: index === 0 ? needsUi : false,
      risk,
      guardrails,
      verifiers,
      skills,
      discovery,
      index: Number(num) - 1,
      unknowns: contractUnknowns,
      researchRefs,
    })
    Object.defineProperty(c, 'research_findings', { value: researchFindings, enumerable: false, writable: true })
    return c
  })

  
  const designBriefs: Record<string, any> = {}
  for (const contract of contracts) {
    if (!contract.needs_ui) continue
    designBriefs[contract.id] = buildDesignBrief({
      request: contract.task,
      discovery,
      repoSignals: designSignals,
    })
  }

  // O contrato é fechado, então a decisão humana vive no briefing, como o design_brief.
  const humanDecisions: Record<string, { reason: string }> = {}
  for (const contract of contracts) {
    const decision = storyHumanDecisionOf(contract)
    if (!decision) continue
    humanDecisions[contract.id] = decision
    questions.push({
      id: `Q-human-${contract.id}`,
      text: `Decisão humana na story ${contract.id}: ${decision.reason}`,
      kind: 'human_decision',
    } as any)
  }

  const planBriefing = {
    ...briefing,
    ...(Object.keys(designBriefs).length > 0 ? { design_briefs: designBriefs } : {}),
    ...(Object.keys(humanDecisions).length > 0 ? { human_decisions: humanDecisions } : {}),
    ...(researchFindings.length > 0 ? { research_findings: researchFindings } : {}),
    ...(researchFallbacks.length > 0 ? { research_fallbacks: researchFallbacks } : {}),
    ...(decisions.length + aiDecisions.length > 0 ? { decisions: [...decisions, ...aiDecisions] } : {}),
  }

  const reqHash = createHash('sha256').update(request).digest('hex')

  const plan = {
    format_version: 2,
    id: `plan-${reqHash.slice(0, 12)}`,
    mission_id: missionIdOf(request),
    immutable_digest: reqHash,
    direction: briefing.direction,
    next_delivery: briefing.next_delivery,
    intent: request,
    briefing: planBriefing,
    authorization: {
      autonomy: 'safe',
      permitted_effects: [],
      eligible_skills: skills,
    },
    phases: [{ epics: [{ stories: contracts.map((c) => c.id) }] }],
    mission_budget: { max_usd: 10 },
    budget: { max_model_calls: 3, max_rework_rounds: 1 },
  }

  Object.defineProperty(plan.budget, 'research_cost_usd', { value: researchCostUsd, enumerable: false, writable: true })
  Object.defineProperty(plan, 'research_findings', { value: researchFindings, enumerable: false, writable: true })

  if (divergenceDetected) Object.defineProperty(plan, 'status', { value: 'awaiting_operator', enumerable: false })

  const stories = planStoriesOf(contracts, humanDecisions)
  return { briefing: planBriefing, plan, contracts, stories, questions, refusedQuestions }
}
