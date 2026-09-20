import { createHash } from 'node:crypto'
import { classifyIntent } from './classify.js'
import { assessRisk } from './risk.js'
import { generateBriefing } from './briefing.js'
import { buildInterview, applyInterviewAnswer, getRefusedQuestions } from './interview.js'
import { runResearchStep } from './research.js'
import { selectEligibleSkills } from './skills.js'
import { splitContract } from './split.js'
import { validateCompiledPlan } from './validate.js'

export {
  classifyIntent,
  buildInterview,
  applyInterviewAnswer,
  runResearchStep,
  selectEligibleSkills,
  splitContract,
  validateCompiledPlan,
}

/** Classes de complexidade que admitem plano progressivo em fatias. */
const BROAD_CLASSES = new Set(['feature', 'epic', 'project'])

/** Quantas entregas entram na fatia executável agora; o resto fica como intenção. */
const IMMEDIATE_SLICE = 2

/**
 * Quebra o pedido nas entregas que ele enumera (vírgulas e conectivo "e").
 *
 * @param {string} request
 * @returns {string[]}
 */
function splitDeliverables(request) {
  return request
    .split(/,| e /i)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
}

function buildVerifiers({ risk, discovery }) {
  const testCmd = discovery.scripts?.test
    ? discovery.scripts.test.split(' ')
    : ['node', 'node_modules/vitest/vitest.mjs', 'run']
  const anchorPaths = (discovery.anchors || []).map((a) => a.path)
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

  // Superfície crítica: além da suíte, um verificador negativo/de recuperação que nomeia
  // a superfície descoberta e o comportamento que precisa ser recusado.
  const surface = risk.surfaces[0]
  const surfaceEvidence = risk.sensitive_paths?.length > 0 ? risk.sensitive_paths : evidence

  return [
    base,
    {
      id: `V2-neg-${surface}`,
      kind: 'script',
      // ponytail: o runner descoberto recebe o filtro por nome (-t); se algum runner não
      // aceitar, o operador ajusta o cmd no contrato antes de aprovar.
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

/** Cenário negativo correspondente ao verificador de recuperação da superfície crítica. */
function criticalScenario({ n, risk, verifiers }) {
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
}) {
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
      maker: { family: 'claude', model_id: 'claude-sonnet-5' },
      checker_round: { family: 'codex', model_id: 'codex-1' },
    },
    budget: { max_model_calls: 3, max_rework_rounds: 1 },
    unknowns: [],
  }
}

/**
 * Compila pedidos em briefing, classificação, entrevista e plano progressivo executável.
 *
 * @param {{
 *   request: string,
 *   discovery?: any,
 *   repoIr?: any,
 *   answers?: any,
 *   eligibleSkills?: any[],
 *   policy?: any,
 *   advisor?: Function,
 *   unknowns?: any[]
 * }} options
 * @returns {Promise<{ briefing: any, plan: any, contracts: any[], questions: any[], refusedQuestions: any[] }>}
 */
export async function compileIntent({
  request = '',
  discovery = {},
  repoIr = {},
  eligibleSkills = [],
  advisor,
  unknowns = [],
}) {
  if (typeof request !== 'string' || request.trim() === '') {
    throw new TypeError('compileIntent: request é obrigatório')
  }

  const classification = await classifyIntent({ request, discovery, repoIr }, advisor)
  const risk = assessRisk({ request, discovery, classification })
  const briefing = generateBriefing({ request, discovery, classification, risk })

  const questions = buildInterview({ unknowns, discovery, repoIr, maxQuestions: 5 })
  const refusedQuestions = getRefusedQuestions({ unknowns, discovery, repoIr })

  const verifiers = buildVerifiers({ risk, discovery })
  const verifierEvidence = verifiers.flatMap((v) => v.evidence || [])
  const baseScopePaths = risk.sensitive_paths
    ? risk.sensitive_paths
    : (discovery.anchors || []).length > 0
      ? discovery.anchors.map((a) => a.path)
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

  const needsUi = Boolean(discovery.ui?.present || /bot[ãa]o|ui|tela|interface/i.test(request))

  const skills = selectEligibleSkills({
    story: {
      domains: classification.domains || (risk.surfaces.includes('auth') ? ['security', 'auth'] : ['backend']),
      languages: (discovery.languages || []).map((l) => l.name),
      task: request,
    },
    eligibleSkills,
  })

  const deliverables = splitDeliverables(request)
  const isBroad = BROAD_CLASSES.has(classification.complexity) && deliverables.length >= 3

  const immediate = isBroad
    ? deliverables.slice(0, IMMEDIATE_SLICE)
    : (deliverables.length > 1 ? deliverables : [request])
  const futureIntent = isBroad ? deliverables.slice(IMMEDIATE_SLICE) : []

  const contracts = immediate.map((deliverable, index) => {
    const idMatch = deliverable.match(/^(S\d+)\b/i)
    const id = idMatch ? idMatch[1].toUpperCase() : `S${index + 1}`
    const num = id.replace(/\D/g, '') || String(index + 1)
    return buildContract({
      id,
      title: deliverable,
      task: deliverable,
      complexity: classification.complexity,
      needsUi: index === 0 ? needsUi : false,
      risk,
      guardrails,
      verifiers,
      skills,
      discovery,
      index: Number(num) - 1,
    })
  })

  // O schema do contrato é fechado: o briefing de UI vive no briefing do plano, por story.
  const designBriefs = {}
  for (const contract of contracts) {
    if (!contract.needs_ui) continue
    designBriefs[contract.id] = {
      components: (discovery.anchors || []).map((a) => a.path),
      description: `Briefing de interface para: ${contract.task.slice(0, 60)}`,
    }
  }

  const planBriefing = {
    ...briefing,
    ...(Object.keys(designBriefs).length > 0 ? { design_briefs: designBriefs } : {}),
    ...(futureIntent.length > 0 ? { future_intent: futureIntent } : {}),
  }

  const reqHash = createHash('sha256').update(request).digest('hex')

  const plan = {
    format_version: 2,
    id: `plan-${reqHash.slice(0, 12)}`,
    mission_id: `mission-${reqHash.slice(0, 12)}`,
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

  return { briefing: planBriefing, plan, contracts, questions, refusedQuestions }
}
