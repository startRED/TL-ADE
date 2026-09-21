// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.js'
import { readJournal } from '../journal/journal.js'

/**
 * Recupera o teto raiz e as reservas consumidas pelas missões ancestrais.
 *
 * @param {{ repoDir: string, plan: any }} input
 * @returns {{ maxModelCalls: number | undefined, consumedCalls: number }}
 */
export function readLineageCallBudget({ repoDir, plan }) {
  let maxModelCalls = plan?.budget?.max_model_calls
  let consumedCalls = 0
  let missionId = plan?.briefing?.replan_from
  const visited = new Set()

  while (missionId) {
    if (visited.has(missionId)) {
      throw new AdeError('lineage_cycle', `linhagem de replanejamento cíclica em ${missionId}`, 4)
    }
    visited.add(missionId)

    const missionDir = path.join(repoDir, '.ade', 'missions', missionId)
    const planPath = path.join(missionDir, 'plan.json')
    const journalPath = path.join(missionDir, 'journal.jsonl')
    if (!fs.existsSync(planPath) || !fs.existsSync(journalPath)) {
      throw new AdeError('lineage_missing', `missão ancestral ${missionId} não encontrada`, 4)
    }

    let ancestorPlan
    try {
      ancestorPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    } catch (err) {
      throw new AdeError('lineage_corrupted', `plano ancestral ${missionId} inválido: ${err?.message || err}`, 4)
    }
    const { events } = readJournal(journalPath)
    consumedCalls += events.filter((event) => event.kind === 'budget_reserved').length
    maxModelCalls = ancestorPlan?.budget?.max_model_calls ?? maxModelCalls
    missionId = ancestorPlan?.briefing?.replan_from
  }

  return { maxModelCalls, consumedCalls }
}

/**
 * Encontra o último evento story_started para a unidade especificada.
 *
 * @param {Array<Record<string, any>>} events Lista de eventos do journal.
 * @param {string} unit Identificador da story/unidade.
 * @returns {{ worktree_dir: string, tree_before: string, base_ref: string | null, base_before: string | null } | null}
 */
export function findStoryStarted(events, unit) {
  if (!Array.isArray(events)) {
    return null
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.kind === 'story_started') {
      const eventUnit = ev.data?.unit ?? ev.unit
      if (
        eventUnit === unit &&
        ev.data &&
        typeof ev.data.worktree_dir === 'string' &&
        typeof ev.data.tree_before === 'string'
      ) {
        return {
          worktree_dir: ev.data.worktree_dir,
          tree_before: ev.data.tree_before,
          base_ref: typeof ev.data.base_ref === 'string' ? ev.data.base_ref : null,
          base_before: typeof ev.data.base_before === 'string' ? ev.data.base_before : null,
        }
      }
    }
  }
  return null
}

/**
 * Encontra o último evento story_done com status 'committed' para a unidade especificada.
 *
 * @param {Array<Record<string, any>>} events Lista de eventos do journal.
 * @param {string} unit Identificador da story/unidade.
 * @returns {{ commit: string } | null}
 */
export function findStoryCommitted(events, unit) {
  if (!Array.isArray(events)) {
    return null
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.kind === 'story_done') {
      const eventUnit = ev.data?.unit ?? ev.unit
      if (
        eventUnit === unit &&
        (ev.data?.status === 'committed' || ev.data?.status === 'delivered') &&
        typeof ev.data.commit === 'string'
      ) {
        return {
          commit: ev.data.commit,
        }
      }
    }
    if (ev && ev.kind === 'decision' && ev.data?.decision === 'stories_preserved' && Array.isArray(ev.data?.preserved)) {
      const p = ev.data.preserved.find((item) => (item?.unit === unit) && typeof item?.commit === 'string')
      if (p && (p.status === 'committed' || p.status === 'delivered')) {
        return {
          commit: p.commit,
        }
      }
    }
  }
  return null
}
