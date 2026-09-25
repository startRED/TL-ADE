import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { AdeError } from '../journal/errors.ts'
import { projectMissionFromSources } from './projection.ts'

const execFileAsync = promisify(execFile)

export interface UnitStep { name: string; state: string; at: string }
export interface UnitSummary { id: string; title: string | null; state: string; rounds: number; steps: UnitStep[] }
export interface DiffFile { file: string; lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }> }
export interface UnitTest { name: string; status: 'passed' | 'failed' | 'red_at_start'; baseline_red: boolean }
export interface UnitFinding { id: string; severity: string; text: string; status: 'open' | 'withdrawn' | 'resolved'; citation: string | null }
export interface UnitDetail {
  id: string
  base_commit: string | null
  head_commit: string | null
  diff: DiffFile[]
  tests: UnitTest[]
  review: { verdict: string; model_id: string | null; findings: UnitFinding[] } | null
  /** Skills que cada papel recebeu na última chamada dele nesta parte, com o modelo que fez o papel. */
  skills: UnitRoleSkills[]
}
export interface UnitRoleSkills { role: 'prova' | 'código' | 'revisão'; model_id: string | null; family: string | null; skills: string[] }

const ROLE_PT: Record<string, UnitRoleSkills['role']> = { prova: 'prova', maker: 'código', checker_round: 'revisão' }

/** Última chamada de cada papel na parte (telemetria): o modelo e as skills que foram no pacote dele. */
function skillsOf(events: any[], unit: string): UnitRoleSkills[] {
  const last = new Map<string, any>()
  for (const ev of events) {
    const role = ROLE_PT[ev.data?.role]
    if (ev.kind === 'telemetry' && role && (ev.data?.story_id ?? unitOf(ev)) === unit) last.set(role, ev.data)
  }
  return (['prova', 'código', 'revisão'] as const).filter((role) => last.has(role)).map((role) => {
    const d = last.get(role)
    return { role, model_id: d.models?.find((m: any) => m.role === 'executor')?.model_id ?? null, family: d.family ?? null, skills: (d.skills_injected ?? []).map((k: any) => k.name) }
  })
}

const notFound = (what: string) => new AdeError('unit_not_found', `${what} não encontrada.`, 2)

/** Missão do projeto pela pasta; id fora do formato ou sem plano vira 404, nunca caminho fora de .ade/missions. */
function loadMission(repoDir: string, missionId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) throw notFound(`Missão ${missionId}`)
  const missionDir = path.join(repoDir, '.ade', 'missions', missionId)
  if (!fs.existsSync(path.join(missionDir, 'plan.json'))) throw notFound(`Missão ${missionId}`)
  return projectMissionFromSources({ missionDir })
}

const unitOf = (ev: any): string | undefined => ev.data?.unit

/** Passos da parte na ordem do journal: cada step_intent com o estado do seu step_result (ou 'running'). */
function stepsOf(events: any[], unit: string): UnitStep[] {
  const results = new Map<string, any>()
  for (const ev of events) if (ev.kind === 'step_result') results.set(ev.step_id, ev)
  return events
    .filter((ev) => ev.kind === 'step_intent' && unitOf(ev) === unit)
    .map((ev) => {
      const result = results.get(ev.step_id)
      // vermelho que não falhou (ou nem rodou) é o passo que estaciona a parte: com "ok" a tela mostrava "prova falhou
      // antes do código" com um visto enquanto o cartão dizia o contrário
      const r = result?.data?.result ?? result?.result
      const notRed = r?.phase === 'red' && typeof r.verdict === 'string' && !r.verdict.startsWith('red')
      return { name: ev.step_id, state: notRed ? 'red_not_red' : result?.status ?? 'running', at: result?.at ?? ev.at }
    })
}

/** Partes da missão com estado, rodadas de revisão e passos. */
export function listUnits(repoDir: string, missionId: string): UnitSummary[] {
  const mission = loadMission(repoDir, missionId)
  return mission.stories.map((s: any) => ({
    id: s.id,
    title: s.title ?? null,
    state: s.status ?? 'pending',
    rounds: mission.events.filter((ev: any) => ev.kind === 'review_result' && unitOf(ev) === s.id).length,
    steps: stepsOf(mission.events, s.id),
  }))
}

/** Converte a saída de git diff em arquivos e linhas marcadas; cabeçalhos de arquivo ficam de fora. */
function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let inHunk = false
  for (const line of text.split('\n')) {
    const header = line.match(/^diff --git a\/.* b\/(.*)$/)
    if (header) {
      current = { file: header[1], lines: [] }
      files.push(current)
      inHunk = false
    } else if (current && line.startsWith('@@')) {
      inHunk = true
      current.lines.push({ kind: 'ctx', text: line })
    } else if (current && inHunk && line !== '' && line !== '\\ No newline at end of file') {
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
      current.lines.push({ kind, text: line.slice(1) })
    }
  }
  return files
}

/** Provas da parte: evals (a fase vermelha é a vermelha na largada) e as vermelhas cobradas do último portão. */
function testsOf(events: any[], unit: string): UnitTest[] {
  const evalSteps = new Set(events.filter((ev) => ev.kind === 'step_intent' && ev.effect_class === 'eval_run' && unitOf(ev) === unit).map((ev) => ev.step_id))
  const latest = new Map<string, any>()
  for (const ev of events) {
    const record = ev.data?.result
    if (ev.kind === 'step_result' && ev.status === 'ok' && evalSteps.has(ev.step_id) && typeof record?.eval_id === 'string') {
      latest.set(`${record.phase}:${record.eval_id}`, record)
    }
  }
  const charged: UnitTest[] = []
  const baseline: UnitTest[] = []
  for (const record of latest.values()) {
    if (record.phase === 'red') {
      if (record.verdict === 'red_valid') baseline.push({ name: record.eval_id, status: 'red_at_start', baseline_red: true })
    } else {
      charged.push({ name: record.eval_id, status: record.verdict === 'green' ? 'passed' : 'failed', baseline_red: false })
    }
  }
  const gates = events.filter((ev) => ev.kind === 'gates_done' && unitOf(ev) === unit).at(-1)
  for (const gate of gates?.data?.results ?? []) {
    for (const name of gate.chargeable_reds ?? []) charged.push({ name, status: 'failed', baseline_red: false })
  }
  return [...charged, ...baseline]
}

/** Parecer da última revisão; achado retirado fica retirado, achado que sumiu da última revisão foi resolvido. */
function reviewOf(events: any[], unit: string): UnitDetail['review'] {
  const reviews = events.filter((ev) => ev.kind === 'review_result' && unitOf(ev) === unit)
  if (reviews.length === 0) return null
  const last = reviews.at(-1)
  const lastIds = new Set((last.data?.result?.action_items ?? []).map((f: any) => f.id))
  const findings = new Map<string, UnitFinding>()
  for (const review of reviews) {
    for (const f of review.data?.result?.action_items ?? []) {
      const withdrawn = f.withdrawn === true || findings.get(f.id)?.status === 'withdrawn'
      findings.set(f.id, {
        id: f.id,
        severity: f.severity,
        text: f.problem,
        status: withdrawn ? 'withdrawn' : lastIds.has(f.id) ? 'open' : 'resolved',
        citation: f.citation ?? findings.get(f.id)?.citation ?? null,
      })
    }
  }
  const checker = events.filter((ev) => ev.kind === 'telemetry' && unitOf(ev) === unit && ev.data?.role === 'checker_round').at(-1)
  return {
    verdict: last.data?.verdict ?? 'unknown',
    model_id: checker?.data?.models?.find((m: any) => m.role === 'executor')?.model_id ?? null,
    findings: [...findings.values()],
  }
}

/** Detalhe da parte: diff do commit-base ao commit da parte (nunca índice nem árvore de trabalho), provas e parecer. */
export async function readUnit(repoDir: string, missionId: string, unitId: string): Promise<UnitDetail> {
  const mission = loadMission(repoDir, missionId)
  if (!mission.stories.some((s: any) => s.id === unitId)) throw notFound(`Parte ${unitId}`)
  const events: any[] = mission.events
  const started = events.filter((ev) => ev.kind === 'story_started' && unitOf(ev) === unitId).at(-1)
  const done = events.filter((ev) => ev.kind === 'story_done' && unitOf(ev) === unitId).at(-1)
  const base: string | null = started?.data?.base_before ?? null
  const head: string | null = done?.data?.commit ?? null
  let diff: DiffFile[] = []
  if (base && head) {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color', '--no-ext-diff', `${base}..${head}`], {
      cwd: repoDir,
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    })
    diff = parseDiff(stdout)
  }
  return { id: unitId, base_commit: base, head_commit: head, diff, tests: testsOf(events, unitId), review: reviewOf(events, unitId), skills: skillsOf(events, unitId) }
}

export type LogLine = { seq: number; at: string | null; unit: string | null; text: string }

/** O que cada passo do motor fez, numa frase; o id cru do passo fica de fora (a tabela já mostra os detalhes). */
function stepPhrase(stepId: string, status: string | undefined): string {
  const ok = status === 'ok' || status === undefined
  const r = /:r(\d+)(?:t\d+)?:(maker|checker)/.exec(stepId)
  if (r) return r[2] === 'maker' ? `rodada ${r[1]}: escreveu o código` : `rodada ${r[1]}: revisão de outra empresa terminou`
  if (/:proof(:|$)/.test(stepId)) return 'escreveu as provas dos critérios'
  if (/^eval:.*:red:/.test(stepId)) return 'rodou a prova antes do código'
  if (/^eval:.*:green:/.test(stepId)) return 'rodou a prova depois do código'
  if (stepId.endsWith(':prepare')) return 'preparou a cópia de trabalho'
  if (stepId.endsWith(':contain')) return 'conferiu o que mudou e o escopo'
  if (stepId.endsWith(':commit')) return 'fez o commit da parte'
  if (stepId.endsWith(':deliver')) return ok ? 'entregou a parte no projeto' : 'não conseguiu entregar a parte'
  return stepId
}

const VERDICT_PT: Record<string, string> = { eval_born_green: 'já passava antes do código', red_valid: 'falhou como devia', downgraded_additive: 'não falhou pelo motivo certo', green: 'passou', red: 'falhou' }
const PHASE_PT: Record<string, string> = { implementation: 'escrever o código', proof: 'escrever as provas', rework: 'corrigir' }
const DECISION_PT: Record<string, string> = { plan_approved: 'plano aprovado', proof_written: 'provas escritas', mission_replaced: 'missão replanejada' }

function logText(ev: any): string | null {
  const d = ev.data ?? {}
  switch (ev.kind) {
    // só as etapas demoradas (chamadas de modelo) avisam que começaram; as outras aparecem quando terminam
    case 'step_intent': return /:(proof(:[a-z0-9:]+)?|r\d+(t\d+)?:(maker|checker))$/.test(String(ev.step_id)) ? `${stepPhrase(String(ev.step_id), undefined)}…`.replace('escreveu', 'escrevendo').replace('terminou', 'em andamento') : null
    case 'step_result': return `${ev.status === 'ok' ? '✓' : '✗'} ${stepPhrase(String(ev.step_id), ev.status)}${VERDICT_PT[d.result?.verdict] ? `: ${VERDICT_PT[d.result.verdict]}` : ''}`
    case 'story_started': return 'parte começou'
    case 'story_done': return d.status === 'delivered' || d.status === 'committed' ? 'parte pronta e entregue' : `parte parou: ${d.reason ?? d.status}`
    case 'review_result': return `revisão: ${d.verdict === 'approved' ? 'aprovou' : d.verdict === 'changes_requested' ? 'pediu mudanças' : d.verdict ?? 'sem veredito'}${d.approved ? ', aceita' : d.errors?.length ? `, recusada (${d.errors.map((e: any) => e.code).join(', ')})` : ''}`
    case 'budget_reserved': return `reservou ${d.calls ?? 1} chamada de ${d.family ?? 'modelo'}${PHASE_PT[d.phase] ? ` para ${PHASE_PT[d.phase]}` : ''}`
    case 'mission_control': return `controle da missão: ${d.state === 'STOPPED' ? 'pausada' : d.state === 'DRAINING' ? 'pausando' : 'rodando'}`
    case 'mission_paused': return `pausa por cota até ${d.resume_at}`
    case 'mission_resumed': return 'retomou depois da pausa'
    case 'preflight_result': return `checagem antes de começar: ${d.ready === false ? 'bloqueada' : 'ok'}`
    case 'batch_open': return 'missão começou'
    case 'batch_close': return 'missão terminou'
    case 'operational_block': return `bloqueio: ${d.reason}`
    case 'decision': if (DECISION_PT[d.decision]) return DECISION_PT[d.decision]
      return d.decision === 'maker_ladder' ? `escada de quem escreve: ${d.outcome} → ${d.next}` : `decisão: ${d.decision}`
    case 'contain_result': return d.ok === false ? `contenção: ${d.reason}` : null
    case 'gates_done': return 'portões de qualidade conferidos'
    default: return null
  }
}

/** Atividade completa da missão em frases, a partir de um seq (o painel pede só o que é novo). */
export function missionLog(repoDir: string, missionId: string, since = 0): LogLine[] {
  const { events } = loadMission(repoDir, missionId)
  const lines: LogLine[] = []
  // o resultado de um passo não repete a parte: vem do pedido do mesmo passo
  const unitOfStep = new Map<string, string>()
  for (const ev of events) {
    const unit = ev.kind === 'step_intent' ? unitOf(ev) : undefined
    if (unit) unitOfStep.set(ev.step_id, unit)
  }
  for (const ev of events) {
    if ((ev.seq ?? 0) <= since) continue
    const text = logText(ev)
    if (text) lines.push({ seq: ev.seq ?? 0, at: ev.at ?? null, unit: (unitOf(ev) ?? unitOfStep.get(ev.step_id))?.split(':')[0] ?? null, text })
  }
  return lines
}
