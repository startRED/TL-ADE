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
      return { name: ev.step_id, state: result?.status ?? 'running', at: result?.at ?? ev.at }
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
  return { id: unitId, base_commit: base, head_commit: head, diff, tests: testsOf(events, unitId), review: reviewOf(events, unitId) }
}
