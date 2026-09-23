// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertProductBriefing, brieferFromConfig, generateProductBriefing, LARGE_COMPLEXITIES, versionPlanOf, type ProductBriefing } from '../intent/briefing.ts'
import { classifyIntent, compileIntent, missionIdOf } from '../intent/compiler.ts'
import { applyInterviewAnswer, buildInterview, unknownsFromRequest, type Decision } from '../intent/interview.ts'
import { AdeError } from '../journal/errors.ts'
import { validateCompiledPlan } from '../intent/validate.ts'
import { planCriticsFromConfig } from '../intent/plan-critic.ts'
import { approvalReasons, critiquePlan, needsPlanCritic, planCriticStale, planIssues, planStoriesOf, storyIdsOf, type PlanCritic } from '../intent/proportional.ts'
import { digest16 } from '../journal/canonical.ts'
import { openJournal, readJournal } from '../journal/journal.ts'
import { buildRuntimeStamp } from '../journal/stamp.ts'
import { loadApprovedSkills } from '../skills/catalog.ts'

/**
 * Escreve um arquivo de forma atômica utilizando arquivo temporário e renomeação.
 */
function writeJsonAtomic(targetPath: string, data: any) {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, targetPath)
}

/**
 * Lê um JSON opcional da missão (contexto herdável), devolvendo null quando ausente.
 */
function readJsonIfExists(filePath: string): any {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * Estados de story que a projeção canônica do projeto considera concluídos
 * (mesma política de src/docs/projection.ts e src/engine/resume.ts).
 */
const DONE_STATUSES = new Set(['delivered', 'committed'])

/**
 * Chave estável de um entregável: o texto da story sem o marcador de id que o operador
 * pode ter escrito ("S2 criar migrações" e "criar migrações" são o mesmo entregável),
 * sem acentos, pontuação nem variação de caixa. É por ela que o replanejamento reconhece
 * trabalho já concluído, e não pelo id posicional que o compilador gera.
 */
function deliverableKey(text: string): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^s\d+\b/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Menor id `S<n>` ainda livre. Determinístico: mesma entrada, mesmo id.
 */
function nextFreeStoryId(usedIds: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = `S${n}`
    if (!usedIds.has(candidate)) return candidate
  }
}

/**
 * Digest canônico de cada contrato referenciado pelo plano. Contrato ausente ou ilegível
 * vira `null` para que a comparação com o conjunto congelado falhe fechado.
 */
function contractDigests({ missionDir, plan }: { missionDir: string; plan: any }): Record<string, string | null> {
  const storiesDir = path.join(missionDir, 'stories')
  
  const digests: Record<string, string | null> = {}
  for (const storyId of storyIdsOf(plan)) {
    const contractPath = path.join(storiesDir, `${storyId}.json`)
    try {
      digests[storyId] = digest16(JSON.parse(fs.readFileSync(contractPath, 'utf8')))
    } catch {
      digests[storyId] = null
    }
  }
  return digests
}

/**
 * Marca nas incógnitas de todos os contratos do plano como cada pergunta da entrevista foi
 * resolvida: a resposta é da missão, não de uma story.
 */
function applyAnswers(contracts: any[], questions: any[], answers: InterviewAnswer[]): void {
  for (const question of questions) {
    const answer = answers.find((a) => a.question_id === question.id)?.option_id
    for (let i = 0; i < contracts.length; i++) {
      contracts[i] = applyInterviewAnswer(contracts[i], question, answer).contract
    }
  }
}

/**
 * Estado de uma missão lido do disco: 'awaiting_answers' enquanto só a entrevista foi
 * gravada, 'awaiting_briefing_approval' enquanto só o briefing de produto foi; com plano, 'approved', 'awaiting_approval' ou 'planned'. Null quando não existe.
 */
function missionStateOf(missionDir: string): string | null {
  const planPath = path.join(missionDir, 'plan.json')
  if (fs.existsSync(planPath)) {
    const journalPath = path.join(missionDir, 'journal.jsonl')
    const approved =
      fs.existsSync(journalPath) &&
      readJournal(journalPath).events.some((e) => e.kind === 'decision' && e.data?.decision === 'plan_approved')
    if (approved) return 'approved'
    return approvalReasons(readJsonIfExists(planPath)).length > 0 ? 'awaiting_approval' : 'planned'
  }
  return readJsonIfExists(path.join(missionDir, 'context.json'))?.state ?? null
}

/**
 * Abre o arquivo de lock da missão em modo exclusivo. Devolve null quando outro
 * processo já está na seção crítica.
 *
 * ponytail: lock de arquivo `wx`; um processo morto deixa o lock para trás e exige
 * remoção manual. Trocar por lock com PID/TTL se a aprovação virar serviço.
 */
function acquireMissionLock(lockPath: string): number | null {
  try {
    return fs.openSync(lockPath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return null
    throw err
  }
}

/**
 * Roda fn com o lock exclusivo da pasta da missão: suspensão e retomada concorrentes não
 * podem deixar perguntas pendentes ao lado de um plano gravado.
 */
async function withMissionLock<T>(missionDir: string, missionId: string, fn: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(missionDir, { recursive: true })
  const lockPath = path.join(missionDir, 'plan.lock')
  const lockFd = acquireMissionLock(lockPath)
  if (lockFd === null) {
    throw new AdeError('mission_busy', `planejamento concorrente em andamento para a missão ${missionId}`, 5, { mission_id: missionId })
  }
  try {
    return await fn()
  } finally {
    fs.closeSync(lockFd)
    fs.rmSync(lockPath, { force: true })
  }
}

/**
 * Críticos do plano: os injetados sempre leem; os dos papéis de .ade/config.json, quando o
 * plano é de alto risco ou quando `always` (revalidação de um plano já criticado).
 */
function planCriticsOf(plan: any, deps: any, repoDir: string, always: boolean): PlanCritic[] {
  if (Array.isArray(deps.planCritics)) return deps.planCritics
  if (!always && !needsPlanCritic(plan)) return []
  return planCriticsFromConfig(deps.adeConfig, {
    repoDir,
    env: deps.env,
    runWorkerImpl: deps.runWorkerImpl,
    resolveBinaryImpl: deps.resolveBinary,
  })
}

/**
 * Grava no briefing a crítica das stories do plano, com os critérios do épico (a versão atual
 * do briefing de produto). Crítica de plano corrigido fica marcada: não aprova sozinha.
 */
async function critiqueInto(plan: any, contracts: any[], critics: PlanCritic[], revalidated: boolean): Promise<void> {
  const epicAcceptance: string[] = plan.briefing.product?.versions?.[plan.briefing.version_index ?? 0]?.includes ?? []
  const critic = await critiquePlan({ plan, contracts }, critics, { epicAcceptance })
  plan.briefing.plan_critic = revalidated ? { ...critic, revalidated: true } : critic
}

/** Decisão 'briefing_approved' gravada no journal da missão, ou null. */
function briefingApprovalOf(missionDir: string): any {
  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) return null
  return readJournal(journalPath).events.find((e) => e.kind === 'decision' && e.data?.decision === 'briefing_approved')?.data ?? null
}

/** Carimbo de runtime usado pelas decisões de planejamento gravadas no journal. */
function planningRuntimeStamp() {
  return buildRuntimeStamp({
    configDigest: '0123456789abcdef',
    capabilitiesDigest: '0123456789abcdef',
  })
}

/**
 * Constrói a estrutura básica de descoberta do repositório a partir de package.json.
 */
function getProjectDiscovery(repoDir: string): any {
  const pkgPath = path.join(repoDir, 'package.json')
  let scripts = {}
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      scripts = pkg.scripts || {}
    } catch {
      // ignore
    }
  }
  return {
    repo: { head: 'HEAD', dirty: false },
    scripts,
    languages: [{ name: 'javascript', share: 1 }],
    anchors: [],
    ui: { present: false },
  }
}

/** Resposta de entrevista: a opção escolhida para uma pergunta gravada. */
type InterviewAnswer = { question_id: string; option_id: string }

type PlanArgs = {
  request: string
  repoDir?: string
  fromMissionId?: string
  nonInteractive?: boolean
}

type PlanResult = {
  missionId: string
  planPath: string | null
  digest: string | null
  state: string
  questions: any[]
}

/**
 * Planeja uma missão a partir de um pedido. Em modo interativo, dúvida de produto sem
 * resposta suspende a missão em 'awaiting_answers' gravando só as perguntas em context.json;
 * em modo não interativo a recomendação é adotada com origem 'padrao' e o plano é gravado.
 */
export function planMission(args: PlanArgs & { nonInteractive: true }, deps?: any): Promise<PlanResult & { planPath: string; digest: string }>
export function planMission(args: PlanArgs, deps?: any): Promise<PlanResult>
export async function planMission({ request, repoDir, fromMissionId, nonInteractive }: PlanArgs, deps: any = {}): Promise<PlanResult> {
  if (typeof request !== 'string' || !request.trim()) {
    throw new TypeError('planMission: request é obrigatório')
  }

  const resolvedRepoDir = path.resolve(repoDir || process.cwd())

  if (fromMissionId) {
    const replanRes = await replanRemaining(
      { repoDir: resolvedRepoDir, fromMissionId, request },
      deps,
    )
    const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', replanRes.missionId)
    const planPath = path.join(missionDir, 'plan.json')
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    const digest = digest16(planObj)
    return {
      missionId: replanRes.missionId,
      planPath,
      digest,
      state: approvalReasons(planObj).length > 0 ? 'awaiting_approval' : 'planned',
      questions: [],
    }
  }

  const discovery = deps.discovery || getProjectDiscovery(resolvedRepoDir)
  // Sem lista injetada, as dúvidas são as perguntas que o próprio pedido deixa em aberto.
  const unknowns = deps.unknowns ?? unknownsFromRequest(request)
  const interview = buildInterview({ unknowns, discovery, repoIr: deps.repoIr || {}, maxQuestions: 5 })
  const missionId = missionIdOf(request)

  if (!nonInteractive && interview.length > 0) {
    // Entrevista antes do plano: nada aprovável é gravado até as respostas chegarem.
    const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', missionId)
    return withMissionLock(missionDir, missionId, () => {
      // O mesmo pedido cai na mesma pasta: perguntas ao lado de um plano anterior tornariam
      // a missão impossível de retomar, e o plano existente não pode ser apagado.
      const state = missionStateOf(missionDir)
      if (state !== null && state !== 'awaiting_answers') {
        throw new AdeError(
          'mission_already_planned',
          `missão ${missionId} já está em ${state}; replaneje com ade plan --from ${missionId}`,
          2,
          { mission_id: missionId, state },
        )
      }
      writeJsonAtomic(path.join(missionDir, 'context.json'), {
        state: 'awaiting_answers',
        request,
        discovery,
        unknowns,
        questions: interview,
        answers: [],
        decisions: [],
      })
      return { missionId, planPath: null, digest: null, state: 'awaiting_answers', questions: interview }
    })
  }

  return compileAndWritePlan({ missionId, request, repoDir: resolvedRepoDir, discovery, unknowns, interview, answers: [] }, deps)
}

/**
 * Retoma uma missão suspensa em 'awaiting_answers' aplicando as respostas às perguntas já
 * gravadas: a descoberta e a entrevista não rodam de novo e o plano vai para a mesma pasta.
 */
export async function resumeMissionAnswers(
  { missionId, repoDir, answers }: { missionId: string; repoDir?: string; answers: InterviewAnswer[] },
  deps: any = {},
): Promise<PlanResult> {
  if (!Array.isArray(answers) || answers.some((a) => typeof a?.question_id !== 'string' || typeof a?.option_id !== 'string')) {
    throw new AdeError('invalid_answers', 'respostas devem ser uma lista de { question_id, option_id }', 2)
  }
  const resolvedRepoDir = path.resolve(repoDir || process.cwd())
  const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', String(missionId))
  if (missionStateOf(missionDir) === null) {
    throw new AdeError('mission_not_found', `missão ${missionId} não existe`, 2, { mission_id: missionId })
  }

  // Duas retomadas ao mesmo tempo não podem compilar e gravar dois planos na mesma pasta.
  return withMissionLock(missionDir, missionId, async () => {
    const state = missionStateOf(missionDir)
    if (state !== 'awaiting_answers') {
      throw new AdeError('mission_not_awaiting_answers', `missão ${missionId} está em ${state}, não aguarda respostas`, 2, {
        mission_id: missionId,
        state,
      })
    }
    const context = readJsonIfExists(path.join(missionDir, 'context.json'))
    const seen = new Set<string>()
    for (const answer of answers) {
      if (!context.questions.some((q: any) => q.id === answer.question_id) || seen.has(answer.question_id)) {
        throw new AdeError('invalid_answer', `resposta cita pergunta inexistente ou repetida: ${answer.question_id}`, 2, {
          question_id: answer.question_id,
        })
      }
      seen.add(answer.question_id)
    }

    return compileAndWritePlan(
      {
        missionId,
        request: context.request,
        repoDir: resolvedRepoDir,
        discovery: context.discovery,
        unknowns: context.unknowns,
        interview: context.questions,
        answers,
      },
      deps,
    )
  })
}

/**
 * Compila o plano a partir da entrevista já montada e das respostas, grava contratos,
 * plano e contexto herdável na pasta da missão.
 */
async function compileAndWritePlan(
  { missionId, request, repoDir: resolvedRepoDir, discovery, unknowns, interview, answers, classification: givenClassification, product }: {
    missionId: string
    request: string
    repoDir: string
    discovery: any
    unknowns: any[]
    interview: any[]
    answers: InterviewAnswer[]
    classification?: any
    /** Briefing de produto já aprovado: o plano cobre a primeira versão dele. */
    product?: ProductBriefing
  },
  deps: any,
): Promise<PlanResult> {
  const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', missionId)
  const classification = givenClassification ?? (await classifyIntent({ request, discovery, repoIr: deps.repoIr || {} }, deps.advisor))
  // Pedido grande para no briefing de produto: nenhum plano técnico antes da aprovação dele.
  if (!product && LARGE_COMPLEXITIES.has(classification.complexity)) {
    const briefer = deps.briefer ?? brieferFromConfig(deps.adeConfig, {
      missionId,
      repoDir: resolvedRepoDir,
      env: deps.env,
      runWorkerImpl: deps.runWorkerImpl,
      resolveBinaryImpl: deps.resolveBinary,
    })
    const briefing = await generateProductBriefing({ request, discovery, classification }, briefer)
    writeJsonAtomic(path.join(missionDir, 'briefing.json'), briefing)
    writeJsonAtomic(path.join(missionDir, 'context.json'), {
      state: 'awaiting_briefing_approval',
      request,
      discovery,
      unknowns,
      questions: interview,
      answers,
      classification,
    })
    return { missionId, planPath: null, digest: digest16(briefing), state: 'awaiting_briefing_approval', questions: [] }
  }
  const version = product ? versionPlanOf(product, 0) : null

  // As respostas viram decisões antes da compilação: resposta inválida falha sem chamar modelo
  // e as escolhas orientam os contratos compilados.
  const interviewDecisions = interview.map(
    (q) => applyInterviewAnswer({}, q, answers.find((a) => a.question_id === q.id)?.option_id).decision,
  )
  const compiled = await compileIntent({
    request: version?.request ?? request,
    discovery,
    repoIr: deps.repoIr || {},
    eligibleSkills: deps.eligibleSkills || [],
    advisor: deps.advisor,
    unknowns,
    interview,
    decisions: interviewDecisions,
    classification,
    deliverables: version?.deliverables,
    researcher: deps.researcher,
    policy: deps.policy,
    adeConfig: deps.adeConfig,
    budget: deps.budget,
  })

  const { plan, questions } = compiled
  const contracts = compiled.contracts
  applyAnswers(contracts, interview, answers)
  const decisions: Decision[] = plan.briefing.decisions || []
  plan.mission_id = missionId
  if (version) Object.assign(plan.briefing, version.briefing)
  const storiesDir = path.join(missionDir, 'stories')

  // Gravações atômicas dos contratos das stories
  fs.mkdirSync(storiesDir, { recursive: true })
  for (const contract of contracts) {
    const contractPath = path.join(storiesDir, `${contract.id}.json`)
    writeJsonAtomic(contractPath, contract)
  }

  // Validação do plano compilado e contratos
  const validation = validateCompiledPlan(plan, contracts)
  if (!validation.valid) {
    const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ')
    throw new Error(`Plano compilado inválido: ${details}`)
  }

  const issues = planIssues({ stories: planStoriesOf(contracts, plan.briefing.human_decisions) })
  if (issues.length > 0) {
    throw new Error(`Plano compilado inválido: ${issues.map((i) => `${i.story}: ${i.problem}`).join(', ')}`)
  }

  // A crítica fica no briefing: entra no digest que o operador aprova.
  const critics = planCriticsOf(plan, deps, resolvedRepoDir, false)
  if (critics.length > 0) await critiqueInto(plan, contracts, critics, false)

  const planPath = path.join(missionDir, 'plan.json')
  writeJsonAtomic(planPath, plan)

  // Descoberta e respostas ficam fora do plano (schema fechado) para poderem ser
  // herdadas por um replanejamento sem alterar o digest aprovado.
  writeJsonAtomic(path.join(missionDir, 'context.json'), {
    request,
    discovery,
    unknowns,
    questions: questions || [],
    answers,
    decisions,
  })

  const digest = digest16(plan)

  return {
    missionId,
    planPath,
    digest,
    state: approvalReasons(plan).length > 0 ? 'awaiting_approval' : 'planned',
    questions: questions || [],
  }
}

/**
 * Valida deterministicamente um plano de missão e seus contratos referenciados.
 */
export function validateMissionPlan(planPath: string): {
  valid: boolean
  digest?: string
  errors: Array<{ path: string; message: string; code?: string }>
} {
  if (typeof planPath !== 'string' || !planPath) {
    return {
      valid: false,
      errors: [{ path: '/', message: 'Caminho do plano não fornecido', code: 'missing_path' }],
    }
  }

  let rawText
  try {
    rawText = fs.readFileSync(planPath, 'utf8')
  } catch {
    return {
      valid: false,
      errors: [{ path: '/', message: `Arquivo não encontrado ou ilegível: ${planPath}`, code: 'file_unreadable' }],
    }
  }

  let plan
  try {
    plan = JSON.parse(rawText)
  } catch {
    return {
      valid: false,
      errors: [{ path: '/', message: `JSON inválido no plano: ${planPath}`, code: 'invalid_json' }],
    }
  }

  const missionDir = path.dirname(path.resolve(planPath))
  const storiesDir = path.join(missionDir, 'stories')

  const contracts = []
  const missingContractErrors = []

  for (const storyId of storyIdsOf(plan)) {
    const contractPath = path.join(storiesDir, `${storyId}.json`)
    if (!fs.existsSync(contractPath)) {
      missingContractErrors.push({
        path: `/stories/${storyId}`,
        message: `Contrato ausente para story: ${storyId}`,
        code: 'contract_missing',
      })
    } else {
      try {
        const contractRaw = fs.readFileSync(contractPath, 'utf8')
        const contract = JSON.parse(contractRaw)
        contracts.push(contract)
      } catch {
        missingContractErrors.push({
          path: `/stories/${storyId}`,
          message: `Contrato ilegível ou JSON inválido: ${storyId}`,
          code: 'invalid_contract',
        })
      }
    }
  }

  const compiledVal = validateCompiledPlan(plan, contracts)
  const allErrors = [...missingContractErrors, ...compiledVal.errors]

  if (allErrors.length > 0) {
    return {
      valid: false,
      errors: allErrors,
    }
  }

  const digest = digest16(plan)
  return {
    valid: true,
    digest,
    errors: [],
  }
}

/**
 * Aprova duravelmente uma missão congelando plano, efeitos e skills no journal.
 */
export async function approveMission(
  { repoDir, missionId, expectedDigest, source, reason }: {
    repoDir?: string
    missionId: string
    expectedDigest: string
    source?: string
    reason?: string
  },
  deps: any = {},
): Promise<{
  approved: boolean
  digest?: string
  eligibleSkills?: string[]
  eligibleSkillPins?: Array<{ id: string; sha256: string }>
  permittedEffects?: string[]
  reason?: string
  errors?: any[]
  state?: string
  planDigest?: string | null
}> {
  if (!missionId || !expectedDigest) {
    return {
      approved: false,
      reason: 'missionId e expectedDigest são obrigatórios',
    }
  }

  const resolvedRepoDir = path.resolve(repoDir || process.cwd())
  let missionDir = path.join(resolvedRepoDir, '.ade', 'missions', missionId)
  if (!fs.existsSync(missionDir) && fs.existsSync(path.join(resolvedRepoDir, 'plan.json'))) {
    missionDir = resolvedRepoDir
  }
  const planPath = path.join(missionDir, 'plan.json')

  if (!fs.existsSync(planPath) && missionStateOf(missionDir) === 'awaiting_briefing_approval') {
    return approveBriefing({ missionDir, missionId, repoDir: resolvedRepoDir, expectedDigest, source }, deps)
  }

  if (!fs.existsSync(planPath)) {
    return {
      approved: false,
      reason: `plano não encontrado em ${planPath}`,
    }
  }

  let planObj
  try {
    planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  } catch {
    return {
      approved: false,
      reason: 'plano ilegível ou JSON inválido',
    }
  }

  const currentDigest = digest16(planObj)
  if (currentDigest !== expectedDigest) {
    return {
      approved: false,
      reason: `digest incompatível ou plano alterado: esperado ${expectedDigest}, atual ${currentDigest}`,
    }
  }

  // Crítica que leu outras stories não vale para este plano: aprovar exige a crítica refeita.
  if (planCriticStale(planObj)) {
    throw new AdeError(
      'plan_critic_stale',
      `crítica desatualizada: as stories do plano mudaram depois dela; rode ade plan --mission ${missionId} --recritique antes de aprovar`,
      2,
      { mission_id: missionId },
    )
  }

  const valResult = validateMissionPlan(planPath)
  if (!valResult.valid) {
    return {
      approved: false,
      reason: 'plano ou contratos inválidos',
      errors: valResult.errors,
    }
  }

  // Plano de briefing de produto só é aprovável com o mesmo briefing que o usuário aprovou.
  if (planObj.briefing?.product) {
    const approvedDigest = briefingApprovalOf(missionDir)?.digest ?? null
    const briefingPath = path.join(missionDir, 'briefing.json')
    const savedDigest = fs.existsSync(briefingPath) ? digest16(readJsonIfExists(briefingPath)) : null
    if (!approvedDigest || approvedDigest !== savedDigest || approvedDigest !== digest16(planObj.briefing.product)) {
      return {
        approved: false,
        reason: `digest do briefing divergente: aprovado ${approvedDigest ?? 'ausente'}, gravado ${savedDigest ?? 'ausente'}`,
      }
    }
  }

  const eligibleSkills = planObj.authorization?.eligible_skills || []
  const permittedEffects = planObj.authorization?.permitted_effects || []
  
  let eligibleSkillPins: Array<{ id: string; sha256: string }> = []
  if (eligibleSkills.length > 0) {
    const catalogDir = deps.catalogDir || path.join(deps.env?.ADE_HOME || os.homedir(), '.ade', 'catalog')
    try {
      eligibleSkillPins = loadApprovedSkills({ catalogDir, approvedSkills: eligibleSkills }).snapshot
    } catch (err) {
      return { approved: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // O congelamento cobre o plano e cada contrato referenciado: alterar uma story depois
  // da aprovação não muda o digest do plano, mas muda este conjunto.
  const frozenContracts = contractDigests({ missionDir, plan: planObj })
  const summaryDigest = digest16({ plan: expectedDigest, contracts: frozenContracts, skills: eligibleSkillPins })

  // Consulta e gravação na mesma seção crítica: duas aprovações concorrentes não podem
  // observar o journal vazio e gravar duas decisões com o mesmo seq/prev.
  const lockPath = path.join(missionDir, 'approve.lock')
  const lockFd = acquireMissionLock(lockPath)
  if (lockFd === null) {
    return {
      approved: false,
      reason: `aprovação concorrente em andamento para a missão ${missionId}`,
    }
  }

  try {
    const journalPath = path.join(missionDir, 'journal.jsonl')
    if (fs.existsSync(journalPath)) {
      const { events } = readJournal(journalPath)
      const existingApproval = events.find(
        (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
      )
      if (existingApproval) {
        if (existingApproval.data?.summary_digest === summaryDigest) {
          return {
            approved: true,
            digest: expectedDigest,
            eligibleSkills: existingApproval.data?.eligible_skills || eligibleSkills,
            eligibleSkillPins: existingApproval.data?.eligible_skill_pins || eligibleSkillPins,
            permittedEffects: existingApproval.data?.permitted_effects || permittedEffects,
          }
        }
        return {
          approved: false,
          reason: 'missão já aprovada com plano ou contratos incompatíveis',
        }
      }
    }

    const journal = openJournal({ missionDir, runtimeStamp: planningRuntimeStamp() })
    await journal.append({
      kind: 'decision',
      source: source || 'operator',
      data: {
        decision: 'plan_approved',
        digest: expectedDigest,
        summary_digest: summaryDigest,
        contract_digests: frozenContracts,
        eligible_skills: eligibleSkills,
        eligible_skill_pins: eligibleSkillPins,
        permitted_effects: permittedEffects,
        ...(reason ? { reason } : {}),
      },
    })
    await journal.close()
  } finally {
    fs.closeSync(lockFd)
    fs.rmSync(lockPath, { force: true })
  }

  return {
    approved: true,
    digest: expectedDigest,
    eligibleSkills,
    eligibleSkillPins,
    permittedEffects,
  }
}

/**
 * Aprova o briefing de produto pelo digest, registra 'briefing_approved' e compila o plano da
 * primeira versão, que para em 'awaiting_approval' esperando a segunda aprovação.
 */
async function approveBriefing(
  { missionDir, missionId, repoDir, expectedDigest, source }: {
    missionDir: string
    missionId: string
    repoDir: string
    expectedDigest: string
    source?: string
  },
  deps: any,
): Promise<{ approved: boolean; digest?: string; reason?: string; state?: string; planDigest?: string | null }> {
  return withMissionLock(missionDir, missionId, async () => {
    const state = missionStateOf(missionDir)
    if (state !== 'awaiting_briefing_approval') {
      return { approved: false, reason: `missão ${missionId} está em ${state}, não aguarda aprovação do briefing` }
    }
    const briefing = readJsonIfExists(path.join(missionDir, 'briefing.json'))
    assertProductBriefing(briefing)
    const digest = digest16(briefing)
    if (digest !== expectedDigest) {
      return { approved: false, reason: `digest do briefing incompatível: esperado ${expectedDigest}, atual ${digest}` }
    }
    // Compilação que falhou depois da aprovação pode ser retomada, mas só com o mesmo briefing.
    const previous = briefingApprovalOf(missionDir)
    if (previous && previous.digest !== digest) {
      return { approved: false, reason: `briefing alterado depois da aprovação: aprovado ${previous.digest}, atual ${digest}` }
    }
    if (!previous) {
      const journal = openJournal({ missionDir, runtimeStamp: planningRuntimeStamp() })
      await journal.append({ kind: 'decision', source: source || 'operator', data: { decision: 'briefing_approved', digest } })
      await journal.close()
    }
    const context = readJsonIfExists(path.join(missionDir, 'context.json'))
    const planned = await compileAndWritePlan(
      {
        missionId,
        request: context.request,
        repoDir,
        discovery: context.discovery,
        unknowns: context.unknowns,
        interview: context.questions,
        answers: context.answers,
        classification: context.classification,
        product: briefing,
      },
      deps,
    )
    return { approved: true, digest, state: planned.state, planDigest: planned.digest }
  })
}

/**
 * Refaz a crítica sobre as stories atuais de um plano ainda não aprovado (`ade plan
 * --mission <id> --recritique`). A crítica nova não aprova: o plano espera `ade approve`.
 */
export async function recritiqueMission({ missionId, repoDir }: { missionId: string; repoDir?: string }, deps: any = {}): Promise<PlanResult> {
  const resolvedRepoDir = path.resolve(repoDir || process.cwd())
  const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', String(missionId))
  if (missionStateOf(missionDir) === null) {
    throw new AdeError('mission_not_found', `missão ${missionId} não existe`, 2, { mission_id: missionId })
  }
  return withMissionLock(missionDir, missionId, async () => {
    const state = missionStateOf(missionDir)
    if (state !== 'awaiting_approval' && state !== 'planned') {
      throw new AdeError('mission_not_recritiquable', `missão ${missionId} está em ${state}; só plano ainda não aprovado tem a crítica refeita`, 2, {
        mission_id: missionId,
        state,
      })
    }
    const planPath = path.join(missionDir, 'plan.json')
    const plan = readJsonIfExists(planPath)
    const contracts = storyIdsOf(plan).map((id) => readJsonIfExists(path.join(missionDir, 'stories', `${id}.json`)))
    const absent = storyIdsOf(plan).filter((_, i) => contracts[i] === null)
    if (absent.length > 0) {
      throw new AdeError('story_contract_missing', `contratos ausentes na missão ${missionId}: ${absent.join(', ')}`, 2, { mission_id: missionId })
    }
    const critics = planCriticsOf(plan, deps, resolvedRepoDir, true)
    if (critics.length === 0) {
      throw new AdeError('plan_critic_unavailable', 'nenhum crítico do plano: configure um papel codex ou agy em .ade/config.json', 2, { mission_id: missionId })
    }
    await critiqueInto(plan, contracts, critics, true)
    writeJsonAtomic(planPath, plan)
    return { missionId, planPath, digest: digest16(plan), state: approvalReasons(plan).length > 0 ? 'awaiting_approval' : 'planned', questions: [] }
  })
}

/**
 * Assegura que o plano fornecido coincide exatamente com a aprovação durável no journal.
 */
export function assertApprovedPlan({ missionDir, plan, skillSnapshot }: {
    missionDir: string
    plan: any
    skillSnapshot?: Array<{ id: string; sha256: string }>
  }): {
  digest: string
  eligibleSkills: string[]
  eligibleSkillPins: Array<{ id: string; sha256: string }>
  permittedEffects: string[]
} {
  if (!missionDir || !plan) {
    throw new TypeError('assertApprovedPlan: missionDir e plan são obrigatórios')
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) {
    throw new Error('assertApprovedPlan: journal não encontrado na missão')
  }

  const { events } = readJournal(journalPath)
  const approvalEvent = events.find(
    (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
  )
  if (!approvalEvent) {
    throw new Error('assertApprovedPlan: plano não possui aprovação registrada no journal')
  }

  const approvedDigest = approvalEvent.data?.digest
  const currentDigest = digest16(plan)

  if (currentDigest !== approvedDigest) {
    throw new Error(
      `assertApprovedPlan: digest alterado (mismatch: plano atual tem digest ${currentDigest}, aprovado ${approvedDigest})`,
    )
  }

  // Contratos também são congelados: relê stories/*.json e recusa qualquer divergência.
  const frozenContracts = approvalEvent.data?.contract_digests || {}
  const currentContracts = contractDigests({ missionDir, plan })
  const contractIds = new Set([...Object.keys(frozenContracts), ...Object.keys(currentContracts)])
  for (const id of contractIds) {
    if (frozenContracts[id] !== currentContracts[id]) {
      throw new Error(
        `assertApprovedPlan: contrato ${id} alterado após a aprovação (digest mismatch: aprovado ${frozenContracts[id] ?? 'ausente'}, atual ${currentContracts[id] ?? 'ausente'})`,
      )
    }
  }

  // Skills também são congeladas: nenhuma skill fora do conjunto aprovado pode ser introduzida
  const frozenSkills = new Set(approvalEvent.data?.eligible_skills || [])
  const currentSkills = plan.authorization?.eligible_skills || []
  for (const sk of currentSkills) {
    if (!frozenSkills.has(sk)) {
      throw new Error(`assertApprovedPlan: skill ${sk} não aprovada encontrada no plano (digest alterado / mismatch)`)
    }
  }

  const frozenPins = approvalEvent.data?.eligible_skill_pins
  if (Array.isArray(frozenPins) && frozenPins.length > 0) {
    if (!Array.isArray(skillSnapshot) || digest16(frozenPins) !== digest16(skillSnapshot)) {
      throw new Error('assertApprovedPlan: hashes das skills aprovadas divergiram do catálogo (mismatch)')
    }
  } else if (frozenSkills.size > 0) {
    throw new Error('assertApprovedPlan: aprovação antiga não congela hashes das skills (mismatch)')
  }

  return {
    digest: currentDigest,
    eligibleSkills: approvalEvent.data?.eligible_skills || plan.authorization?.eligible_skills || [],
    eligibleSkillPins: frozenPins || [],
    permittedEffects: approvalEvent.data?.permitted_effects || plan.authorization?.permitted_effects || [],
  }
}

/**
 * Replaneja o trabalho restante de uma missão anterior, preservando stories concluídas por digest.
 */
export async function replanRemaining(
  { repoDir, fromMissionId, request }: {
    repoDir?: string
    fromMissionId: string
    request?: string
  },
  deps: any = {},
): Promise<{
  missionId: string
  preservedStories: any[]
  replannedStories: any[]
}> {
  if (!fromMissionId) {
    throw new TypeError('replanRemaining: fromMissionId é obrigatório')
  }

  const resolvedRepoDir = path.resolve(repoDir || process.cwd())
  const oldMissionDir = path.join(resolvedRepoDir, '.ade', 'missions', fromMissionId)
  const oldPlanPath = path.join(oldMissionDir, 'plan.json')
  const oldJournalPath = path.join(oldMissionDir, 'journal.jsonl')

  if (!fs.existsSync(oldPlanPath)) {
    throw new Error(`replanRemaining: missão anterior não encontrada em ${oldPlanPath}`)
  }

  const oldPlan = JSON.parse(fs.readFileSync(oldPlanPath, 'utf8'))
  const { events: oldEvents } = readJournal(oldJournalPath)

  // Só o motivo explícito `no_changes` consome o limite de tentativa inconclusiva:
  // falha de preflight, orçamento, gate ou revisão também é `awaiting_operator` e não
  // pode bloquear um replanejamento posterior.
  const hadNoChanges = oldEvents.some(
    (e) => e.kind === 'story_done' && e.data?.reason === 'no_changes',
  )

  const previousReplanCount = oldPlan.briefing?.replan_count || 0
  const isAlreadyReplanned = Boolean(oldPlan.briefing?.replan_from) || previousReplanCount >= 1

  // Regra de governança: no_changes admite no máximo 1 replanejamento automático
  if (hadNoChanges && isAlreadyReplanned) {
    throw new Error(
      'Limite de tentativas de replanejamento excedido: story com no_changes admite no máximo uma tentativa de replanejamento automático',
    )
  }

  // Identificar stories concluídas segundo a política canônica de estados concluídos
  // (o motor grava tanto `committed` quanto `delivered`) e o resultado de cada uma.
  const completedResults = new Map()
  for (const ev of oldEvents) {
    if (ev.kind === 'story_done' && DONE_STATUSES.has(ev.data?.status)) {
      const unit = ev.unit || ev.data?.unit
      if (unit) completedResults.set(unit, { status: ev.data.status, commit: ev.data?.commit ?? null })
    }
  }

  // Digests congelados na aprovação da missão anterior: o resultado preservado fica
  // ligado ao digest original, não ao arquivo atual (que pode ter mudado depois).
  const oldApproval = oldEvents.find(
    (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
  )
  const frozenDigests = oldApproval?.data?.contract_digests || {}

  // Preservar stories concluídas
  const preservedStories = []
  const preservedResults = []
  const oldStoriesDir = path.join(oldMissionDir, 'stories')
  for (const [storyId, result] of completedResults) {
    const storyFile = path.join(oldStoriesDir, `${storyId}.json`)
    if (!fs.existsSync(storyFile)) continue
    const contract = JSON.parse(fs.readFileSync(storyFile, 'utf8'))
    const currentDigest = digest16(contract)
    const frozenDigest = frozenDigests[storyId]
    if (frozenDigest != null && frozenDigest !== currentDigest) {
      throw new Error(
        `replanRemaining: contrato ${storyId} da missão ${fromMissionId} mudou após a aprovação (aprovado ${frozenDigest}, atual ${currentDigest}); resultado concluído não pode ser religado a outro digest`,
      )
    }
    preservedStories.push(contract)
    preservedResults.push({
      unit: storyId,
      status: result.status,
      commit: result.commit,
      digest: frozenDigest ?? currentDigest,
      from_mission: fromMissionId,
    })
  }

  // Herdar descoberta e respostas da entrevista da missão anterior
  const oldContext = readJsonIfExists(path.join(oldMissionDir, 'context.json')) || {}
  const discovery =
    deps.discovery ||
    oldContext.discovery ||
    oldPlan.briefing?.discovery ||
    getProjectDiscovery(resolvedRepoDir)
  const inheritedAnswers = Array.isArray(oldContext.answers) ? oldContext.answers : []

  // Determinar requisição restante
  const effectiveRequest = request || oldPlan.intent

  // Plano de briefing de produto: versão entregue passa para a seguinte do mesmo briefing
  // aprovado, sem nova aprovação dele; versão incompleta é replanejada na mesma versão.
  const product = oldPlan.briefing?.product
  let version: ReturnType<typeof versionPlanOf> | null = null
  if (product) {
    if (briefingApprovalOf(oldMissionDir)?.digest !== digest16(product)) {
      throw new AdeError('briefing_not_approved', `briefing da missão ${fromMissionId} não tem aprovação válida`, 2, { mission_id: fromMissionId })
    }
    const oldIndex = oldPlan.briefing.version_index ?? 0
    const delivered = storyIdsOf(oldPlan).every((id) => completedResults.has(id))
    version = versionPlanOf(product, delivered ? oldIndex + 1 : oldIndex)
  }

  // Compilar novas stories
  const compiled = await compileIntent({
    request: version?.request ?? effectiveRequest,
    ...(version ? { deliverables: version.deliverables, classification: oldPlan.briefing.classification } : {}),
    discovery,
    repoIr: deps.repoIr || {},
    eligibleSkills: oldPlan.authorization?.eligible_skills || deps.eligibleSkills || [],
    advisor: deps.advisor,
    unknowns: deps.unknowns || [],
    researcher: deps.researcher,
    policy: deps.policy,
    adeConfig: deps.adeConfig,
    budget: deps.budget,
  })

  const { plan: newPlanTemplate } = compiled

  // Somente o trabalho restante é recompilado. O que já está concluído é reconhecido pelo
  // ENTREGÁVEL (texto da task), não pelo id posicional que o compilador gera: sem isso um
  // pedido sem ids explícitos renumeraria "criar migrações" como S1 e ela seria descartada
  // só por colidir com a S1 concluída. Colisão de id entre trabalho diferente é resolvida
  // com um id livre determinístico, nunca com descarte.
  const completedIds = new Set(preservedStories.map((s) => s.id))
  const completedDeliverables = new Set(preservedStories.map((s) => deliverableKey(s.task ?? s.title)))

  const usedIds = new Set(completedIds)
  /** @type id compilado -> id final (null = já concluído) */
  const idMap: Map<string, string | null> = new Map()
  const newContracts = []

  for (const contract of compiled.contracts) {
    if (completedDeliverables.has(deliverableKey(contract.task ?? contract.title))) {
      idMap.set(contract.id, null)
      continue
    }
    const finalId = usedIds.has(contract.id) ? nextFreeStoryId(usedIds) : contract.id
    idMap.set(contract.id, finalId)
    usedIds.add(finalId)
    if (finalId !== contract.id) {
      if (typeof contract.title === 'string' && contract.title.startsWith(contract.id)) {
        contract.title = finalId + contract.title.slice(contract.id.length)
      }
      contract.id = finalId
    }
    newContracts.push(contract)
  }

  for (const contract of newContracts) {
    if (!Array.isArray(contract.depends_on)) continue
    // Dependência de story concluída já está satisfeita e não pertence a este plano;
    // dependência de story renomeada passa a apontar para o id final.
    const remaining = contract.depends_on
      .map((dep: string) => (idMap.has(dep) ? idMap.get(dep) : dep))
      .filter((dep: string | null | undefined) => dep != null && !completedIds.has(dep))
    if (remaining.length > 0) contract.depends_on = remaining
    else delete contract.depends_on
  }
  // As decisões herdadas já estão no contexto anterior; aqui só marcam as incógnitas respondidas.
  const answeredQuestions = (Array.isArray(oldContext.questions) ? oldContext.questions : []).filter((q: any) =>
    inheritedAnswers.some((a: any) => a?.question_id === q.id),
  )
  applyAnswers(newContracts, answeredQuestions, inheritedAnswers)

  const allIds = [...preservedStories.map((s) => s.id), ...newContracts.map((c) => c.id)]
  if (new Set(allIds).size !== allIds.length) {
    throw new Error(`replanRemaining: ids de story duplicados na missão substituta: ${allIds.join(', ')}`)
  }

  let newMissionId = newPlanTemplate.mission_id
  if (newMissionId === fromMissionId) {
    newMissionId = `mission-${digest16({ fromMissionId, req: effectiveRequest, t: Date.now() }).slice(0, 12)}`
  }

  const newMissionDir = path.join(resolvedRepoDir, '.ade', 'missions', newMissionId)
  const newStoriesDir = path.join(newMissionDir, 'stories')
  fs.mkdirSync(newStoriesDir, { recursive: true })

  // Copiar contratos preservados garantindo mesmo digest
  for (const s of preservedStories) {
    const srcFile = path.join(oldStoriesDir, `${s.id}.json`)
    const destFile = path.join(newStoriesDir, `${s.id}.json`)
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, destFile)
    } else {
      writeJsonAtomic(destFile, s)
    }
  }

  // Gravar novos contratos
  for (const c of newContracts) {
    const destFile = path.join(newStoriesDir, `${c.id}.json`)
    writeJsonAtomic(destFile, c)
  }

  // Só o trabalho restante entra nas fases: story concluída não volta para despacho.
  const newPlan = {
    ...newPlanTemplate,
    id: `plan-${newMissionId.replace(/^mission-/, '')}`,
    mission_id: newMissionId,
    phases: [{ epics: [{ stories: newContracts.map((c) => c.id) }] }],
    briefing: {
      ...newPlanTemplate.briefing,
      replan_from: fromMissionId,
      replan_count: previousReplanCount + 1,
      discovery,
      ...version?.briefing,
    },
  }
  // Plano corrigido: a crítica roda de novo antes de ele poder ser aprovado.
  // Sem crítico disponível para revalidar um plano já criticado, a crítica grava 'failed' sem
  // tentativas e o portão de aprovação fica fechado.
  const mustRecritique = Boolean(oldPlan.briefing?.plan_critic)
  const critics = planCriticsOf(newPlan, deps, resolvedRepoDir, mustRecritique)
  if (critics.length > 0 || mustRecritique) await critiqueInto(newPlan, newContracts, critics, true)
  newPlan.immutable_digest = digest16(newPlan)

  const newPlanPath = path.join(newMissionDir, 'plan.json')
  writeJsonAtomic(newPlanPath, newPlan)

  writeJsonAtomic(path.join(newMissionDir, 'context.json'), {
    request: effectiveRequest,
    discovery,
    questions: compiled.questions || [],
    answers: inheritedAnswers,
    decisions: Array.isArray(oldContext.decisions) ? oldContext.decisions : [],
    replan_from: fromMissionId,
    preserved: preservedResults,
  })

  // Estado durável da nova missão: as concluídas entram como resultado herdado,
  // ligadas ao commit e ao digest originais, e não como trabalho a despachar.
  const newJournal = openJournal({
    missionDir: newMissionDir,
    runtimeStamp: planningRuntimeStamp(),
  })
  await newJournal.append({
    kind: 'decision',
    source: 'operator',
    data: {
      decision: 'stories_preserved',
      replan_from: fromMissionId,
      preserved: preservedResults,
    },
  })
  if (product) {
    writeJsonAtomic(path.join(newMissionDir, 'briefing.json'), product)
    await newJournal.append({
      kind: 'decision',
      source: 'operator',
      data: { decision: 'briefing_approved', digest: digest16(product), from_mission: fromMissionId },
    })
  }
  await newJournal.close()

  // Marcação durável de substituição na missão anterior
  const oldJournal = openJournal({
    missionDir: oldMissionDir,
    runtimeStamp: planningRuntimeStamp(),
  })

  await oldJournal.append({
    kind: 'decision',
    source: 'operator',
    data: {
      decision: 'mission_replaced',
      replaced_by: newMissionId,
    },
  })
  await oldJournal.close()

  return {
    missionId: newMissionId,
    preservedStories,
    replannedStories: newContracts,
  }
}
