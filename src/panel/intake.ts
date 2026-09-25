import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProductBriefing, brieferFromConfig, generateProductBriefing, LARGE_COMPLEXITIES, versionPlanOf, type ProductBriefing } from '../intent/briefing.ts'
import { classifyIntent, compileIntent } from '../intent/compiler.ts'
import { applyInterviewAnswer, buildInterview, unknownsFromRequest, type Decision } from '../intent/interview.ts'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { approveMission, getProjectDiscovery, recordMissionDecision, validateMissionPlan, writeJsonAtomic } from '../mission/plan-lifecycle.ts'
import { writeMissionOptions, type MissionOptions } from '../mission/options.ts'
import { refreshQuotaReceipts } from '../adapters/local/official-quota.ts'
import { readMissionControl, requestMissionControl } from '../engine/control.ts'
import { parseAttachments, saveAttachments, type AttachmentRecord } from './attachments.ts'
import type { ActivityKind } from './open-projects.ts'
import { readProjectOptions, type SkillSummary } from './options.ts'

export type IntakeStage = 'interview' | 'briefing' | 'plan' | 'running' | 'concluida' | 'recusada'
type Answers = Record<string, string>

/** O que a IA entendeu do pedido: guardado no intake para as etapas seguintes não perguntarem de novo. */
export interface Understanding {
  title?: string
  summary: string
  complexity: string
  difficulty: string
  domains: string[]
  needs_ui: boolean
  /** Do plano: o que o usuário vai ter e o que foi assumido, em linguagem leiga. */
  explanation?: string
  decisions?: string[]
}

export interface Intake {
  mission_id: string
  /** Ordem dos pedidos do projeto: o intake vivo é o de maior seq ainda não encerrado. */
  seq: number
  created_at: string
  request: string
  attachments?: AttachmentRecord[]
  stage: IntakeStage
  questions?: any[]
  answers?: Answers
  decisions?: Decision[]
  briefing?: ProductBriefing
  plan?: any
  parts?: Array<{ id: string; title?: string; task?: string; criteria: string[] }>
  digest?: string
  rejected_at?: 'briefing' | 'plan'
  reason?: string
  error?: string
  understanding?: Understanding
  /** Parada pelo operador: a missão fica como está e não se oferece mais retomar. */
  stopped?: boolean
  /** Fechada pelo operador: a tela volta ao começo do projeto; a missão segue no histórico. */
  closed?: boolean
}

/** Estado de controle da missão do pedido (pausa pedida vira DRAINING e depois STOPPED); null sem journal ainda. */
export function missionControlOf(repoDir: string, missionId: string): 'RUNNING' | 'DRAINING' | 'STOPPED' | null {
  const missionDir = path.join(missionsDir(repoDir), missionId)
  if (!fs.existsSync(path.join(missionDir, 'journal.jsonl'))) return null
  return readMissionControl({ missionDir }).state
}

export interface IntentPort {
  compile(input: {
    request: string
    repoDir: string
    options: MissionOptions
    /** Skills do catálogo fora da quarentena e de plugin ligado no projeto. */
    eligibleSkills: SkillSummary[]
    missionId: string
    answers?: Answers
    /** Briefing de produto já aprovado: o plano cobre a primeira versão dele. */
    briefing?: ProductBriefing
    /** Perguntas já feitas e o entendimento já obtido: a IA não refaz a entrevista ao receber as respostas. */
    questions?: any[]
    understanding?: Understanding
  }): Promise<{ questions?: any[]; briefing?: unknown; plan?: unknown; contracts?: unknown[]; understanding?: Understanding }>
}

export type RunMission = (args: { repoDir: string; missionId: string; planPath: string; options: MissionOptions }) => Promise<void>
/** Ambiente do filho por parâmetro (padrão: o do servidor), para o dogfood trocar a fronteira de modelo sem mexer em process.env. */
type SpawnMissionRun = (args: Parameters<RunMission>[0] & { env?: NodeJS.ProcessEnv }) => Promise<void>

const ADE_BIN = fileURLToPath(new URL('../../bin/ade.js', import.meta.url))

const PENDING: Partial<Record<IntakeStage, [string, string]>> = {
  interview: ['entrevista_pendente', 'Já existe uma entrevista esperando respostas neste projeto.'],
  briefing: ['briefing_pendente', 'Já existe um briefing esperando aprovação neste projeto.'],
  plan: ['plano_pendente', 'Já existe um plano esperando aprovação neste projeto.'],
  running: ['missao_em_execucao', 'Já existe uma missão em execução neste projeto.'],
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const missionsDir = (repoDir: string) => path.join(repoDir, '.ade', 'missions')
const intakePath = (repoDir: string, missionId: string) => path.join(missionsDir(repoDir), missionId, 'intake.json')

/** Toda parte do plano com a última story_done entregue (ou só com commit): a missão chegou ao fim. */
function missionDelivered(repoDir: string, missionId: string): boolean {
  const dir = path.join(missionsDir(repoDir), missionId)
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))
    const stories: string[] = (plan.phases ?? []).flatMap((ph: any) => (ph.epics ?? []).flatMap((ep: any) => ep.stories ?? []))
    if (stories.length === 0) return false
    const last = new Map<string, string>()
    for (const line of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line.includes('"story_done"')) continue
      const ev = JSON.parse(line)
      if (ev.kind === 'story_done') last.set(ev.data?.unit ?? ev.unit, ev.data?.status)
    }
    return stories.every((id) => last.get(id) === 'delivered' || last.get(id) === 'committed')
  } catch {
    return false
  }
}

/** Todos os intakes gravados, religados pelo id da pasta: intake de outra missão é estado corrompido. */
function readIntakes(repoDir: string): Intake[] {
  const dir = missionsDir(repoDir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => fs.existsSync(intakePath(repoDir, name)))
    .map((name) => {
      const intake = JSON.parse(fs.readFileSync(intakePath(repoDir, name), 'utf8')) as Intake
      if (intake.mission_id !== name) {
        throw new AdeError('intake_corrompido', `O intake da pasta ${name} diz ser da missão ${intake.mission_id}.`, 2)
      }
      // erro de uma execução que parou, mas a missão foi terminada depois (outra execução entregou todas as partes):
      // o aviso velho não fica na tela como se a missão tivesse parado (25/09)
      if (intake.error && missionDelivered(repoDir, name)) {
        const { error: _stale, ...rest } = intake
        return rest
      }
      return intake
    })
    .sort((a, b) => a.seq - b.seq)
}

const isLive = (i: Intake) => i.stage !== 'recusada' && i.stage !== 'concluida'
/** Com no máximo um vivo por projeto, o vivo é o mais recente não encerrado. */
const liveOf = (intakes: Intake[]): Intake | undefined => intakes.filter(isLive).at(-1)

/** No máximo 5 perguntas, cada uma com a opção recomendada em primeiro lugar. */
function normalizeQuestions(questions: any[]): any[] {
  return questions.slice(0, 5).map((q) => {
    if (typeof q?.id !== 'string' || !Array.isArray(q.options) || q.options.length === 0) {
      throw new AdeError('pergunta_invalida', 'A entrevista trouxe pergunta sem id ou sem opções.', 2)
    }
    const recommended = q.options.find((o: any) => o?.recommended) ?? q.options[0]
    return { ...q, options: [{ ...recommended, recommended: true }, ...q.options.filter((o: any) => o !== recommended)] }
  })
}

type ResultKind = 'questions' | 'briefing' | 'plan'

/** Leva o intake à etapa que o resultado da porta de intenção pede; plano vai para o disco da missão. */
function applyResult(repoDir: string, intake: Intake, result: Awaited<ReturnType<IntentPort['compile']>>, allowed: ResultKind[]): void {
  const kind: ResultKind | null = result.questions?.length ? 'questions' : result.briefing ? 'briefing' : result.plan ? 'plan' : null
  if (result.understanding) intake.understanding = result.understanding
  if (!kind || !allowed.includes(kind)) {
    throw new AdeError('intencao_inesperada', `A compilação do pedido devolveu ${kind ?? 'nada'}, mas esta etapa espera ${allowed.join(' ou ')}.`, 2)
  }
  if (kind === 'questions') {
    intake.stage = 'interview'
    intake.questions = normalizeQuestions(result.questions ?? [])
    return
  }
  if (kind === 'briefing') {
    assertProductBriefing(result.briefing)
    intake.stage = 'briefing'
    intake.briefing = result.briefing
    intake.digest = digest16(result.briefing)
    return
  }
  const plan: any = result.plan
  const contracts: any[] = Array.isArray(result.contracts) ? result.contracts : []
  plan.mission_id = intake.mission_id
  const missionDir = path.join(missionsDir(repoDir), intake.mission_id)
  for (const contract of contracts) writeJsonAtomic(path.join(missionDir, 'stories', `${contract.id}.json`), contract)
  const planPath = path.join(missionDir, 'plan.json')
  writeJsonAtomic(planPath, plan)
  const validation = validateMissionPlan(planPath)
  if (!validation.valid) {
    throw new AdeError('plano_invalido', `Plano compilado inválido: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`, 2)
  }
  intake.stage = 'plan'
  intake.plan = plan
  intake.digest = digest16(plan)
  intake.parts = contracts.map((c) => ({
    id: c.id,
    title: c.title,
    task: c.task,
    criteria: (c.scenarios ?? []).map((s: any) => `Dado ${s.given}, quando ${s.when}, então ${s.then}`),
  }))
}

function assertReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw new AdeError('motivo_vazio', 'Diga o motivo da recusa.', 2)
  return reason.trim()
}

/**
 * Intake do painel: pedido, entrevista, briefing e plano de cada projeto, durável em
 * .ade/missions/<id>/intake.json. Um projeto tem no máximo um intake vivo, e as operações
 * de um mesmo projeto passam em fila, então dois pedidos ao mesmo tempo não criam dois.
 */
export function createIntake({ intent, runMission, eligibleSkills, beginActivity, onError }: {
  intent: IntentPort
  runMission: RunMission
  eligibleSkills: (repoDir: string) => SkillSummary[]
  beginActivity: (projectId: string, kind: ActivityKind) => () => void
  onError: (message: string) => void
}) {
  const queues = new Map<string, Promise<unknown>>()

  function serialized<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(repoDir) ?? Promise.resolve()).then(fn)
    // A fila só guarda a ordem; o erro segue para quem chamou por `next`.
    queues.set(repoDir, next.then(() => undefined, () => undefined))
    return next
  }

  function write(repoDir: string, intake: Intake): Intake {
    writeJsonAtomic(intakePath(repoDir, intake.mission_id), intake)
    return intake
  }

  /** Intake vivo na etapa pedida; outra etapa (ou nenhum vivo) é conflito. */
  function liveAt(repoDir: string, stage: IntakeStage): Intake {
    const live = liveOf(readIntakes(repoDir))
    if (live?.stage !== stage) {
      throw new AdeError('etapa_errada', `Nenhum pedido deste projeto está na etapa ${stage}${live ? ` (está em ${live.stage})` : ''}.`, 5)
    }
    return live
  }

  /** Roda o motor para o pedido como atividade do projeto; ao sair, o pedido vira concluído (com o erro, se houver). */
  function launch(project: { id: string; path: string }, intake: Intake): Intake {
    const repoDir = project.path
    const missionDir = path.join(missionsDir(repoDir), intake.mission_id)
    const running = write(repoDir, { ...intake, stage: 'running' })
    const release = beginActivity(project.id, 'mission')
    // o que o operador fez enquanto rodava (parar) vale: relê o pedido antes de encerrar
    const finish = (error?: string) => serialized(repoDir, async () => {
      const current = readIntakes(repoDir).find((i) => i.mission_id === intake.mission_id) ?? running
      write(repoDir, { ...current, stage: 'concluida', ...(error ? { error } : {}) })
    })
    runMission({ repoDir, missionId: intake.mission_id, planPath: path.join(missionDir, 'plan.json'), options: readProjectOptions(repoDir) })
      .then(() => finish(), (err) => finish(err instanceof Error ? err.message : String(err)))
      .catch((err) => onError(`ade serve: falha ao encerrar a missão ${intake.mission_id}: ${err instanceof Error ? err.message : String(err)}\n`))
      .finally(release)
    return running
  }

  /** Pedido de pausa ou retomada pelo digest do plano da missão (o mesmo controle do `ade` pela API). */
  async function control(repoDir: string, intake: Intake, action: 'pause' | 'resume') {
    const plan = JSON.parse(fs.readFileSync(path.join(missionsDir(repoDir), intake.mission_id, 'plan.json'), 'utf8'))
    return requestMissionControl({ repoDir, missionId: intake.mission_id, action, expectedDigest: digest16(plan), source: 'panel' })
  }

  const compile = (repoDir: string, intake: Intake, extra: { answers?: Answers; briefing?: ProductBriefing } = {}) =>
    intent.compile({ request: intake.request, repoDir, options: readProjectOptions(repoDir), eligibleSkills: eligibleSkills(repoDir), missionId: intake.mission_id, questions: intake.questions, understanding: intake.understanding, ...extra })

  return {
    /** Último intake do projeto, vivo ou encerrado; null quando nunca houve pedido. */
    find(repoDir: string): Intake | null {
      return readIntakes(repoDir).at(-1) ?? null
    },

    read(repoDir: string): Intake {
      const last = readIntakes(repoDir).at(-1)
      if (!last) throw new AdeError('intake_not_found', 'Este projeto ainda não recebeu nenhum pedido.', 2)
      return last
    },

    submit(repoDir: string, text: unknown, attachments?: unknown): Promise<Intake> {
      if (typeof text !== 'string' || !text.trim()) throw new AdeError('pedido_vazio', 'Escreva o pedido antes de enviar.', 2)
      const files = parseAttachments(attachments)
      return serialized(repoDir, async () => {
        const intakes = readIntakes(repoDir)
        const live = liveOf(intakes)
        const pending = live && PENDING[live.stage]
        if (pending) throw new AdeError(pending[0], pending[1], 5)
        const intake: Intake = {
          mission_id: `mission-${randomBytes(6).toString('hex')}`,
          seq: (intakes.at(-1)?.seq ?? 0) + 1,
          created_at: new Date().toISOString(),
          request: text.trim(),
          stage: 'interview',
        }
        applyResult(repoDir, intake, await compile(repoDir, intake), ['questions', 'briefing', 'plan'])
        if (files.length) intake.attachments = saveAttachments(path.dirname(intakePath(repoDir, intake.mission_id)), files)
        return write(repoDir, intake)
      })
    },

    answer(repoDir: string, answers: unknown): Promise<Intake> {
      if (!isPlainObject(answers) || Object.values(answers).some((v) => typeof v !== 'string')) {
        throw new AdeError('respostas_invalidas', 'As respostas devem ligar o id de cada pergunta ao id da opção escolhida.', 2)
      }
      return serialized(repoDir, async () => {
        const intake = liveAt(repoDir, 'interview')
        const questions = intake.questions ?? []
        const unknown = Object.keys(answers).find((id) => !questions.some((q) => q.id === id))
        if (unknown) throw new AdeError('respostas_invalidas', `A resposta cita a pergunta inexistente ${unknown}.`, 2)
        const decisions = questions.map((q) => applyInterviewAnswer({}, q, answers[q.id] as string | undefined, { allowWritten: true }).decision)
        const result = await compile(repoDir, intake, { answers: answers as Answers })
        const next: Intake = { ...intake, answers: answers as Answers, decisions }
        applyResult(repoDir, next, result, ['briefing', 'plan'])
        return write(repoDir, next)
      })
    },

    approveBriefing(repoDir: string, digest: unknown): Promise<Intake> {
      return serialized(repoDir, async () => {
        const intake = liveAt(repoDir, 'briefing')
        const briefing = intake.briefing as ProductBriefing
        if (digest !== intake.digest) {
          throw new AdeError('digest_desatualizado', `O briefing mudou: aprovado ${String(digest)}, atual ${intake.digest}. Recarregue antes de aprovar.`, 5)
        }
        const result = await compile(repoDir, intake, { answers: intake.answers, briefing })
        // Mesmo briefing gravado e aprovado no journal: approveMission confere os dois contra o plano.
        writeJsonAtomic(path.join(missionsDir(repoDir), intake.mission_id, 'briefing.json'), briefing)
        await recordMissionDecision({ repoDir, missionId: intake.mission_id, source: 'panel', data: { decision: 'briefing_approved', digest: intake.digest } })
        const next: Intake = { ...intake }
        applyResult(repoDir, next, result, ['plan'])
        return write(repoDir, next)
      })
    },

    reject(repoDir: string, stage: 'briefing' | 'plan', reason: unknown): Promise<Intake> {
      const why = assertReason(reason)
      return serialized(repoDir, async () => {
        const intake = liveAt(repoDir, stage)
        await recordMissionDecision({ repoDir, missionId: intake.mission_id, source: 'panel', data: { decision: `${stage}_rejected`, reason: why } })
        return write(repoDir, { ...intake, stage: 'recusada', rejected_at: stage, reason: why })
      })
    },

    /** Aprova o plano pelo digest, fixa as opções na missão e inicia a execução como atividade do projeto. */
    approvePlan(project: { id: string; path: string }, digest: unknown): Promise<Intake> {
      const repoDir = project.path
      return serialized(repoDir, async () => {
        const intake = liveAt(repoDir, 'plan')
        if (typeof digest !== 'string') throw new AdeError('digest_ausente', 'Informe o digest do plano.', 2)
        const approval = await approveMission({ repoDir, missionId: intake.mission_id, expectedDigest: digest, source: 'panel' })
        if (!approval.approved) throw new AdeError('aprovacao_recusada', approval.reason ?? 'O plano não pôde ser aprovado.', 5)
        // As opções de agora ficam fixadas na missão: mudar as do projeto depois não mexe nesta.
        writeMissionOptions(path.join(missionsDir(repoDir), intake.mission_id), readProjectOptions(repoDir))
        return launch(project, intake)
      })
    },

    /** Pausa a missão rodando: a parte em andamento termina e o motor para antes da próxima (pedido durável no journal). */
    pause(project: { id: string; path: string }): Promise<Intake> {
      return serialized(project.path, async () => {
        const intake = liveAt(project.path, 'running')
        await control(project.path, intake, 'pause')
        return intake
      })
    },

    /** Retoma a missão pausada: registra a retomada e roda o motor de novo, do ponto em que parou. */
    resume(project: { id: string; path: string }): Promise<Intake> {
      return serialized(project.path, async () => {
        const last = readIntakes(project.path).at(-1)
        if (!last || last.stage !== 'concluida' || last.stopped || missionControlOf(project.path, last.mission_id) !== 'STOPPED') {
          throw new AdeError('etapa_errada', 'Nenhuma missão pausada para retomar neste projeto.', 5)
        }
        await control(project.path, last, 'resume')
        const { error: _error, ...clean } = last
        return launch(project, clean)
      })
    },

    /** Para de vez: pausa se ainda roda e marca o pedido como parado; o que já foi entregue fica. */
    stop(project: { id: string; path: string }): Promise<Intake> {
      return serialized(project.path, async () => {
        const last = readIntakes(project.path).at(-1)
        if (!last || (last.stage !== 'running' && last.stage !== 'concluida') || last.stopped) {
          throw new AdeError('etapa_errada', 'Nenhuma missão rodando ou pausada para parar neste projeto.', 5)
        }
        if (last.stage === 'running' && missionControlOf(project.path, last.mission_id) === 'RUNNING') await control(project.path, last, 'pause')
        return write(project.path, { ...last, stopped: true })
      })
    },

    /** Fecha a missão terminada, pausada ou parada: a tela volta ao começo do projeto. Rodando não fecha. */
    close(project: { id: string; path: string }): Promise<Intake> {
      return serialized(project.path, async () => {
        const last = readIntakes(project.path).at(-1)
        // concluida = o processo do motor já saiu (terminou, pausou ou parou); rodando não fecha
        if (!last || last.stage !== 'concluida') {
          throw new AdeError('etapa_errada', 'Só fecha missão que terminou, pausou ou parou.', 5)
        }
        return write(project.path, { ...last, closed: true })
      })
    },
  }
}

export type IntakeService = ReturnType<typeof createIntake>

/**
 * Porta padrão de intenção: entrevista pelas dúvidas do pedido, briefing de produto para pedido
 * grande e plano pelo compilador de intenção, na mesma ordem de `ade plan`.
 */
export const defaultIntent: IntentPort = {
  async compile({ request, repoDir, missionId, answers, briefing }) {
    const discovery = getProjectDiscovery(repoDir)
    const unknowns = unknownsFromRequest(request)
    const questions = buildInterview({ unknowns, discovery, maxQuestions: 5 })
    if (!answers && questions.length > 0) return { questions }

    const configPath = path.join(repoDir, '.ade', 'config.json')
    const adeConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined
    const classification = await classifyIntent({ request, discovery })
    if (!briefing && LARGE_COMPLEXITIES.has(classification.complexity)) {
      const briefer = brieferFromConfig(adeConfig, { missionId, repoDir })
      return { briefing: await generateProductBriefing({ request, discovery, classification }, briefer) }
    }

    const version = briefing ? versionPlanOf(briefing, 0) : null
    const decisions = questions.map((q) => applyInterviewAnswer({}, q, answers?.[q.id], { allowWritten: true }).decision)
    const compiled = await compileIntent({
      request: version?.request ?? request,
      discovery,
      unknowns,
      interview: questions,
      decisions,
      classification,
      deliverables: version?.deliverables,
      adeConfig,
    })
    let contracts = compiled.contracts
    for (const q of questions) contracts = contracts.map((c) => applyInterviewAnswer(c, q, answers?.[q.id], { allowWritten: true }).contract)
    if (version) Object.assign(compiled.plan.briefing, version.briefing)
    return { plan: compiled.plan, contracts }
  },
}

/** A sonda real do `ade doctor` vale 24 h para o motor; o painel renova antes com folga. */
const PROBE_FRESH_MS = 20 * 3600 * 1000

/**
 * Renova a sonda do `ade doctor` quando falta, falhou ou venceu: sem ela o pré-voo para a missão pedindo um comando
 * que o usuário do painel não roda. Devolve se precisou renovar.
 */
export async function ensureFreshProbe({ homeDir = os.homedir(), now = Date.now(), runDoctor }: { homeDir?: string; now?: number; runDoctor: () => Promise<void> }): Promise<boolean> {
  try {
    const caps = JSON.parse(fs.readFileSync(path.join(homeDir, '.ade', 'capabilities.json'), 'utf8'))
    const at = Date.parse(caps.probed_at)
    if (caps.probe_ok === true && Number.isFinite(at) && now - at >= 0 && now - at < PROBE_FRESH_MS) return false
  } catch {
    // sem arquivo ou ilegível: renova
  }
  await runDoctor()
  return true
}

/** Roda um comando do `ade` sem shell, com a saída no arquivo aberto. */
function runAde(args: string[], cwd: string, fd: number, what: string, okCodes: number[] = [0], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [ADE_BIN, ...args], { cwd, env, shell: false, stdio: ['ignore', fd, fd] })
    child.once('error', reject)
    child.once('exit', (code) => (code !== null && okCodes.includes(code) ? resolve() : reject(new Error(`${what} saiu com código ${code}`))))
  })
}

/** Porta padrão de execução: renova a sonda se venceu e roda `ade run --plan` sem shell, com a saída em run.log. */
export const spawnMissionRun: SpawnMissionRun = async ({ repoDir, missionId, planPath, env }) => {
  const logPath = path.join(path.dirname(planPath), 'run.log')
  const fd = fs.openSync(logPath, 'a')
  try {
    // Ambiente próprio é o dogfood com dublê: a casa dele já traz sonda e cota, e não se gasta chamada real aqui.
    if (!env) {
      await ensureFreshProbe({ runDoctor: () => runAde(['doctor'], repoDir, fd, 'ade doctor') })
      // O motor só gasta plano com recibo oficial de cota: lê a do Claude, a do Codex e a do Google agora.
      const receipts = await refreshQuotaReceipts()
      fs.writeSync(fd, `cota oficial: ${receipts.map((r) => `${r.family} ${r.used_percent}% da semana`).join(', ') || 'nenhuma leitura'}
`)
    }
    // saída 3 é parte parada esperando você (o motivo fica no journal e aparece na partitura), não erro do painel
    await runAde(['run', '--plan', planPath, '--repo', repoDir], repoDir, fd, `ade run da missão ${missionId}`, [0, 3], env ?? process.env)
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}; saída em ${logPath}`)
  } finally {
    fs.closeSync(fd)
  }
}
