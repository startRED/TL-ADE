// @ts-check
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { checkMissionBudget } from './budget.ts'
import { findStoryStarted } from './resume.ts'
import { nextReady } from './schedule.ts'

/**
 * Classe de efeito do step → efeito externo que o plano aprovado precisa autorizar.
 * Classe externa sem efeito declarável no plano (`ci_rerun`) nunca é autorizável: falha fechado.
 */
export const EXTERNAL_EFFECT_PERMISSION: Readonly<Record<string, string>> = Object.freeze({
  push: 'push',
  pull_request: 'open_pr',
  pull_request_merge: 'merge',
  ci_rerun: 'ci_rerun',
})

/**
 * Envolve o executor de steps recusando, antes do efeito acontecer, qualquer efeito externo
 * fora do `permitted_effects` aprovado. A recusa fica no journal e o motor não concede efeito
 * nenhum por conta própria.
 */
export function guardExternalEffects({ step, journal, permittedEffects = [] }: {
    step: (spec: any, effectFn: any) => Promise<any>
    journal: { append: (event: Record<string, unknown>) => Promise<unknown> }
    permittedEffects?: string[]
  }): (spec: any, effectFn: any) => Promise<any> {
  if (typeof step !== 'function') {
    throw new AdeError('effect_guard_input_invalid', 'guarda de efeitos exige o executor de steps', 4)
  }
  if (!journal || typeof journal.append !== 'function') {
    throw new AdeError('effect_guard_input_invalid', 'guarda de efeitos exige o journal da missão', 4)
  }
  const permitted = Array.isArray(permittedEffects) ? permittedEffects : []

  return async (spec, effectFn) => {
    const required = EXTERNAL_EFFECT_PERMISSION[spec?.effect_class]
    if (required && !permitted.includes(required)) {
      await journal.append({
        kind: 'effect_refused',
        data: {
          unit: spec?.unit ?? null,
          step_id: spec?.id ?? null,
          effect_class: spec?.effect_class,
          required_effect: required,
          permitted_effects: permitted,
          reason: 'effect_not_permitted',
        },
      })
      throw new AdeError(
        'effect_not_permitted',
        `efeito externo fora do aprovado: ${spec?.effect_class} exige ${required} em permitted_effects`,
        5,
        { effect_class: spec?.effect_class, required_effect: required },
      )
    }
    return step(spec, effectFn)
  }
}

/**
 * Laço da noite desatendida: só avança unidade já aprovada no plano congelado, nunca replaneja
 * e nunca concede autorização nova. A unidade que bloqueia estaciona em `awaiting_operator`, as
 * independentes seguem e as dependentes dela não rodam. O lote para entre unidades — a story em
 * curso sempre chega ao próprio checkpoint antes da parada.
 */
export async function runUnattendedBatch(deps: any, { loaded, repoDir, missionDir }: {
    loaded: import('./plan-load.ts').LoadedPlan
    repoDir: string
    missionDir: string
  }): Promise<{
  status: 'completed' | 'awaiting_operator'
  exitCode: number
  completedStories: string[]
  parkedStories: string[]
  reason: string | null
}> {
  const journal = deps?.journal
  if (!journal || typeof journal.append !== 'function') {
    throw new AdeError('journal_missing', 'noite desatendida exige o journal da missão', 4)
  }
  const runStoryFn = deps.runStory
  if (typeof runStoryFn !== 'function') {
    throw new AdeError('run_story_missing', 'noite desatendida exige o executor de stories', 4)
  }
  const now = deps.now ?? (() => Date.now())
  const journalPath = path.join(missionDir, 'journal.jsonl')
  const readEvents = () => readJournal(journalPath).events
  const budget = loaded.missionBudget ?? {}
  // A parede é do lote, não da story: o motor para entre unidades, e a unidade em curso sempre
  // chega ao próprio checkpoint em vez de ser abortada no meio do efeito.
  const { max_wall_clock_seconds: _wallClock, ...storyBudget } = budget
  const storyLoaded = { ...loaded, missionBudget: storyBudget }

  
  const completed: string[] = []
  
  const parked: Map<string, { reason: string; evidence_path: string }> = new Map()
  // A aprovação congelada já foi conferida como primeira precondição dura em `ade run`.
  
  let stopReason: string | null = null

  while (stopReason === null) {
    
    const states: Record<string, any> = {}
    for (const id of completed) states[id] = { status: 'completed' }
    for (const [id, item] of parked) states[id] = { status: 'awaiting_operator', reason: item.reason }

    const gate = checkMissionBudget({ events: readEvents(), budget, now: now(), states })
    if (!gate.allowed) {
      stopReason = gate.reason
      break
    }

    const next = nextReady(loaded.stories, states)
    if (!next) break

    const story = loaded.stories.find((s) => s.id === next.id)
    if (!story) throw new AdeError('story_missing', `story ${next.id} ausente no plano carregado`, 4)

    // `deliver: false`: a unidade para no próprio commit revisado. A base do operador não anda
    // durante a noite; o relatório matinal traz o merge de cada unidade comitada.
    const result = await runStoryFn(deps, {
      loaded: storyLoaded,
      story,
      repoDir,
      missionDir,
      deliver: false,
    })

    if (result.status === 'committed' || result.status === 'delivered') {
      completed.push(story.id)
      continue
    }

    const reason = result.reason ?? 'awaiting_operator'
    const started = findStoryStarted(readEvents(), story.id)
    const evidence_path = path.resolve(started?.worktree_dir || missionDir)
    parked.set(story.id, { reason, evidence_path })
    await journal.append({
      kind: 'unit_parked',
      data: { unit: story.id, reason, evidence_path, next_action: 'operator' },
    })
  }

  const completed_units = [...completed]
  const parked_units = [...parked.keys()]

  if (stopReason !== null) {
    await journal.append({
      kind: 'batch_stopped',
      data: {
        reason: stopReason,
        checkpoint_ref: `journal:${journal.lastSeq}`,
        completed_units,
        parked_units,
      },
    })
  }

  await journal.append({
    kind: 'batch_summary',
    data: {
      completed_units,
      parked_units,
      stop_reason: stopReason,
      parked: [...parked.entries()].map(([unit, item]) => ({
        unit,
        reason: item.reason,
        evidence_path: item.evidence_path,
      })),
    },
  })

  const exitCode = stopReason === null && parked_units.length === 0 ? 0 : 3
  return {
    status: exitCode === 0 ? 'completed' : 'awaiting_operator',
    exitCode,
    completedStories: completed_units,
    parkedStories: parked_units,
    reason: stopReason,
  }
}

export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[Tt][\d:.]+[Zz]\s?/i
export const TIME_RE = /\b(?:\d+(?:\.\d+)?\s?(?:ms|s|m|h)|\d{1,2}:\d{2}(?::\d{2})?)\b/g
export const HEX_RE = /\b[0-9a-f]{7,}\b/g
export const PATH_RE = /(?:[A-Za-z]:)?[\\/][\w.\\/-]+/g
export const NUM_RE = /\b\d+(?:\.\d+)?\b/g

/**
 * Normaliza uma mensagem ou assinatura para comparação determinística.
 */
export function normalize(text: string): string {
  if (typeof text !== 'string') return ''
  let s = text.toLowerCase()
  s = s.replace(TIMESTAMP_RE, '')
  s = s.replace(TIME_RE, '<t>')
  s = s.replace(HEX_RE, '<hex>')
  s = s.replace(PATH_RE, '<path>')
  s = s.replace(NUM_RE, '<n>')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Detecta ciclos, estagnação ou oscilação em assinaturas de execução.
 */
export function detectLoop(signatures: string[], { threshold = 2 }: { threshold?: number } = {}): {
  kind: 'none' | 'oscillation' | 'stagnation'
  signature: string | null
} {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return { kind: 'none', signature: null }
  }

  const norm = signatures.map((s) => (typeof s === 'string' ? normalize(s) : String(s)))
  const last = norm[norm.length - 1]

  // Checagem de estagnação: as últimas N assinaturas são idênticas
  let consecutive = 1
  for (let i = norm.length - 2; i >= 0; i--) {
    if (norm[i] === last) {
      consecutive++
    } else {
      break
    }
  }
  if (consecutive >= threshold) {
    return { kind: 'stagnation', signature: last }
  }

  // Checagem de oscilação: ex. A, B, A (retorno a assinatura anterior após variação)
  if (norm.length >= 3) {
    if (norm[norm.length - 1] === norm[norm.length - 3] && norm[norm.length - 1] !== norm[norm.length - 2]) {
      return { kind: 'oscillation', signature: last }
    }
    for (let i = norm.length - 3; i >= 0; i--) {
      if (norm[i] === last && norm[norm.length - 2] !== last) {
        return { kind: 'oscillation', signature: last }
      }
    }
  }

  return { kind: 'none', signature: null }
}
