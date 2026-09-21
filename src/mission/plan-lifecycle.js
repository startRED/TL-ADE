// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileIntent } from '../intent/compiler.js'
import { applyInterviewAnswer } from '../intent/interview.js'
import { validateCompiledPlan } from '../intent/validate.js'
import { digest16 } from '../journal/canonical.js'
import { openJournal, readJournal } from '../journal/journal.js'
import { buildRuntimeStamp } from '../journal/stamp.js'
import { loadApprovedSkills } from '../skills/catalog.js'

/**
 * Escreve um arquivo de forma atômica utilizando arquivo temporário e renomeação.
 *
 * @param {string} targetPath
 * @param {any} data
 */
function writeJsonAtomic(targetPath, data) {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, targetPath)
}

/**
 * Lê um JSON opcional da missão (contexto herdável), devolvendo null quando ausente.
 *
 * @param {string} filePath
 * @returns {any}
 */
function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * IDs das stories despacháveis declaradas pelo plano, na ordem do plano.
 * Tolera estrutura inválida (fase nula, épico nulo, story não-string): a travessia
 * nunca lança, e é o validador de schema que reporta as violações.
 *
 * @param {any} plan
 * @returns {string[]}
 */
function storyIdsOf(plan) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : []
  return phases.flatMap((phase) => {
    const epics = Array.isArray(phase?.epics) ? phase.epics : []
    return epics.flatMap((epic) => {
      const stories = Array.isArray(epic?.stories) ? epic.stories : []
      return stories.filter((id) => typeof id === 'string' && id !== '')
    })
  })
}

/**
 * Estados de story que a projeção canônica do projeto considera concluídos
 * (mesma política de src/docs/projection.js e src/engine/resume.js).
 */
const DONE_STATUSES = new Set(['delivered', 'committed'])

/**
 * Chave estável de um entregável: o texto da story sem o marcador de id que o operador
 * pode ter escrito ("S2 criar migrações" e "criar migrações" são o mesmo entregável),
 * sem acentos, pontuação nem variação de caixa. É por ela que o replanejamento reconhece
 * trabalho já concluído, e não pelo id posicional que o compilador gera.
 *
 * @param {string} text
 * @returns {string}
 */
function deliverableKey(text) {
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
 *
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function nextFreeStoryId(usedIds) {
  for (let n = 1; ; n++) {
    const candidate = `S${n}`
    if (!usedIds.has(candidate)) return candidate
  }
}

/**
 * Digest canônico de cada contrato referenciado pelo plano. Contrato ausente ou ilegível
 * vira `null` para que a comparação com o conjunto congelado falhe fechado.
 *
 * @param {{ missionDir: string, plan: any }} options
 * @returns {Record<string, string | null>}
 */
function contractDigests({ missionDir, plan }) {
  const storiesDir = path.join(missionDir, 'stories')
  /** @type {Record<string, string | null>} */
  const digests = {}
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
 * Aplica respostas da entrevista aos contratos compilados, devolvendo as decisões geradas.
 * A resposta é da missão: vale para todos os contratos do plano.
 *
 * @param {any[]} contracts
 * @param {Array<{ question: any, answer: any }>} answers
 * @returns {any[]}
 */
function applyAnswers(contracts, answers) {
  const decisions = []
  for (const entry of answers) {
    if (!entry || typeof entry !== 'object' || !entry.question) {
      throw new TypeError('planMission: resposta de entrevista sem pergunta correspondente')
    }
    for (let i = 0; i < contracts.length; i++) {
      const applied = applyInterviewAnswer(contracts[i], entry.question, entry.answer)
      contracts[i] = applied.contract
      if (i === 0) decisions.push(applied.decision)
    }
  }
  return decisions
}

/**
 * Abre o arquivo de lock da missão em modo exclusivo. Devolve null quando outro
 * processo já está na seção crítica.
 *
 * ponytail: lock de arquivo `wx`; um processo morto deixa o lock para trás e exige
 * remoção manual. Trocar por lock com PID/TTL se a aprovação virar serviço.
 *
 * @param {string} lockPath
 * @returns {number | null}
 */
function acquireMissionLock(lockPath) {
  try {
    return fs.openSync(lockPath, 'wx')
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'EEXIST') return null
    throw err
  }
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
 *
 * @param {string} repoDir
 * @returns {any}
 */
function getProjectDiscovery(repoDir) {
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

/**
 * Planeja uma missão a partir de um pedido, salvando plano e contratos na pasta da missão.
 *
 * @param {{
 *   request: string,
 *   repoDir?: string,
 *   fromMissionId?: string,
 *   nonInteractive?: boolean,
 * }} options
 * @param {any} [deps]
 * @returns {Promise<{
 *   missionId: string,
 *   planPath: string,
 *   digest: string,
 *   state: string,
 *   questions: any[],
 * }>}
 */
export async function planMission(
  { request, repoDir, fromMissionId, nonInteractive },
  deps = {},
) {
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
      state: 'planned',
      questions: [],
    }
  }

  const discovery = deps.discovery || getProjectDiscovery(resolvedRepoDir)
  const compiled = await compileIntent({
    request,
    discovery,
    repoIr: deps.repoIr || {},
    eligibleSkills: deps.eligibleSkills || [],
    advisor: deps.advisor,
    unknowns: deps.unknowns || [],
  })

  const { plan, questions } = compiled
  const contracts = compiled.contracts
  const answers = Array.isArray(deps.answers) ? deps.answers : []
  const decisions = applyAnswers(contracts, answers)
  const missionId = plan.mission_id
  const missionDir = path.join(resolvedRepoDir, '.ade', 'missions', missionId)
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

  const planPath = path.join(missionDir, 'plan.json')
  writeJsonAtomic(planPath, plan)

  // Descoberta e respostas ficam fora do plano (schema fechado) para poderem ser
  // herdadas por um replanejamento sem alterar o digest aprovado.
  writeJsonAtomic(path.join(missionDir, 'context.json'), {
    request,
    discovery,
    questions: questions || [],
    answers,
    decisions,
  })

  const digest = digest16(plan)

  return {
    missionId,
    planPath,
    digest,
    state: 'planned',
    questions: questions || [],
  }
}

/**
 * Valida deterministicamente um plano de missão e seus contratos referenciados.
 *
 * @param {string} planPath
 * @returns {{
 *   valid: boolean,
 *   digest?: string,
 *   errors: Array<{ path: string, message: string, code?: string }>,
 * }}
 */
export function validateMissionPlan(planPath) {
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
 *
 * @param {{
 *   repoDir?: string,
 *   missionId: string,
 *   expectedDigest: string,
 *   source?: string,
 *   reason?: string,
 * }} options
 * @param {any} [deps]
 * @returns {Promise<{
 *   approved: boolean,
 *   digest?: string,
 *   eligibleSkills?: string[],
 *   eligibleSkillPins?: Array<{ id: string, sha256: string }>,
 *   permittedEffects?: string[],
 *   reason?: string,
 *   errors?: any[],
 * }>}
 */
export async function approveMission(
  { repoDir, missionId, expectedDigest, source, reason },
  deps = {},
) {
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

  const valResult = validateMissionPlan(planPath)
  if (!valResult.valid) {
    return {
      approved: false,
      reason: 'plano ou contratos inválidos',
      errors: valResult.errors,
    }
  }

  const eligibleSkills = planObj.authorization?.eligible_skills || []
  const permittedEffects = planObj.authorization?.permitted_effects || []
  /** @type {Array<{ id: string, sha256: string }>} */
  let eligibleSkillPins = []
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
 * Assegura que o plano fornecido coincide exatamente com a aprovação durável no journal.
 *
 * @param {{
 *   missionDir: string,
 *   plan: any,
 *   skillSnapshot?: Array<{ id: string, sha256: string }>,
 * }} options
 * @returns {{
 *   digest: string,
 *   eligibleSkills: string[],
 *   eligibleSkillPins: Array<{ id: string, sha256: string }>,
 *   permittedEffects: string[],
 * }}
 */
export function assertApprovedPlan({ missionDir, plan, skillSnapshot }) {
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
 *
 * @param {{
 *   repoDir?: string,
 *   fromMissionId: string,
 *   request?: string,
 * }} options
 * @param {any} [deps]
 * @returns {Promise<{
 *   missionId: string,
 *   preservedStories: any[],
 *   replannedStories: any[],
 * }>}
 */
export async function replanRemaining(
  { repoDir, fromMissionId, request },
  deps = {},
) {
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
  const effectiveRequest =
    request ||
    (oldPlan.briefing?.future_intent && oldPlan.briefing.future_intent.join(' e ')) ||
    oldPlan.intent

  // Compilar novas stories
  const compiled = await compileIntent({
    request: effectiveRequest,
    discovery,
    repoIr: deps.repoIr || {},
    eligibleSkills: oldPlan.authorization?.eligible_skills || deps.eligibleSkills || [],
    advisor: deps.advisor,
    unknowns: deps.unknowns || [],
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
  /** @type {Map<string, string | null>} id compilado -> id final (null = já concluído) */
  const idMap = new Map()
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
      .map((dep) => (idMap.has(dep) ? idMap.get(dep) : dep))
      .filter((dep) => dep !== null && !completedIds.has(dep))
    if (remaining.length > 0) contract.depends_on = remaining
    else delete contract.depends_on
  }
  const inheritedDecisions = applyAnswers(newContracts, inheritedAnswers)

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
    },
  }
  newPlan.immutable_digest = digest16(newPlan)

  const newPlanPath = path.join(newMissionDir, 'plan.json')
  writeJsonAtomic(newPlanPath, newPlan)

  writeJsonAtomic(path.join(newMissionDir, 'context.json'), {
    request: effectiveRequest,
    discovery,
    questions: compiled.questions || [],
    answers: inheritedAnswers,
    decisions: [...(Array.isArray(oldContext.decisions) ? oldContext.decisions : []), ...inheritedDecisions],
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
