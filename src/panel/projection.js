// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { digest16 } from '../journal/canonical.js'
import { readJournal } from '../journal/journal.js'
import { validate } from '../schema/index.js'
import { AdeError } from '../journal/errors.js'

/**
 * Projeta os dados determinísticos de uma missão a partir de suas fontes duráveis
 * (plan.json, journal.jsonl, stories/*.json, artifacts/).
 *
 * @param {{ missionDir: string }} options
 * @returns {any}
 */
export function projectMissionFromSources({ missionDir }) {
  const planPath = path.join(missionDir, 'plan.json')
  if (!fs.existsSync(planPath)) {
    throw new AdeError('plan_missing', `plan.json não encontrado em ${missionDir}`, 2)
  }

  const planText = fs.readFileSync(planPath, 'utf8')
  let plan
  try {
    plan = JSON.parse(planText)
  } catch (err) {
    throw new AdeError('plan_corrupt', `plan.json corrompido em ${planPath}`, 2, { cause: err })
  }

  const missionId = plan.mission_id || path.basename(missionDir)
  const planDigest = digest16(plan)

  const journalPath = path.join(missionDir, 'journal.jsonl')
  /** @type {any[]} */
  let events = []
  if (fs.existsSync(journalPath)) {
    const res = readJournal(journalPath)
    events = res.events
  }

  // Mapear contratos de stories
  const storiesDir = path.join(missionDir, 'stories')
  const contracts = new Map()
  if (fs.existsSync(storiesDir)) {
    const entries = fs.readdirSync(storiesDir)
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        const storyId = entry.slice(0, -5)
        const contractPath = path.join(storiesDir, entry)
        let contract
        try {
          contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
        } catch (err) {
          throw new AdeError('story_contract_corrupt', `Contrato de story corrompido em ${contractPath}`, 2, { cause: err })
        }
        const result = validate('task-contract', contract)
        if (!result.valid) {
          throw new AdeError(
            'story_contract_invalid',
            `Contrato de story inválido em ${contractPath}: ${result.errors.map((error) => `${error.path} ${error.message}`).join(', ')}`,
            2,
          )
        }
        contracts.set(storyId, contract)
      }
    }
  }

  // Extrair stories do plano e seus épicos
  const epics = []
  /** @type {string[]} */
  const storyList = []
  const phases = Array.isArray(plan.phases) ? plan.phases : []

  for (let pIdx = 0; pIdx < phases.length; pIdx++) {
    const phase = phases[pIdx]
    const pEpics = Array.isArray(phase.epics) ? phase.epics : []
    for (let eIdx = 0; eIdx < pEpics.length; eIdx++) {
      const epic = pEpics[eIdx]
      const epicMeta =
        (Array.isArray(plan.briefing?.epics)
          ? plan.briefing.epics.find((/** @type {any} */ x) => x?.id === epic?.id) || plan.briefing.epics[eIdx]
          : null) || {}
      const epicId = epic.id || epicMeta.id || `epic-${pIdx + 1}-${eIdx + 1}`
      const epicTitle = epic.title || epicMeta.title || `Épico ${epicId}`
      const epicStories = Array.isArray(epic.stories) ? epic.stories : []

      epics.push({
        id: epicId,
        title: epicTitle,
        stories: epicStories,
      })

      for (const sId of epicStories) {
        if (typeof sId === 'string' && !storyList.includes(sId)) {
          storyList.push(sId)
        }
      }
    }
  }

  // Mapeamento de eventos por story (status, evals, visual, etc)
  const storyStates = new Map()
  for (const sId of storyList) {
    const contract = contracts.get(sId)
    storyStates.set(sId, {
      id: sId,
      title: contract?.title,
      task: contract?.task,
      complexity: contract?.complexity,
      needs_ui: contract?.needs_ui,
      maker: contract?.roles?.maker,
      status: null,
      reason: null,
      calls: 0,
      cost: null,
      diff: [],
      tests: [],
      visual: null,
      review: null,
    })
  }

  const decisions = []
  let totalCalls = 0
  let totalCostUsd = 0

  for (const ev of events) {
    const unit = ev.unit || ev.data?.unit
    const targetStory = unit ? storyStates.get(unit) : null

    if (ev.kind === 'story_started' && targetStory) {
      targetStory.status = 'in_progress'
    } else if (ev.kind === 'story_done' && targetStory) {
      targetStory.status = ev.data?.status || 'committed'
      targetStory.reason = ev.data?.reason || null
    } else if (ev.kind === 'visual_eval_done' && targetStory) {
      targetStory.visual = ev.data?.evaluation || null
      // Validação do schema visual-eval
      if (targetStory.visual) {
        const vResult = validate('visual-eval', targetStory.visual)
        if (!vResult.valid) {
          throw new AdeError(
            'visual_eval_invalid',
            `visual_eval_done inválido na story ${unit}: ${vResult.errors.map((e) => e.path + ' ' + e.message).join(', ')}`,
            2,
          )
        }
      }
    } else if (ev.kind === 'decision') {
      decisions.push({
        seq: ev.seq,
        at: ev.at,
        decision: ev.data?.decision,
        source: ev.source || 'operator',
        data: ev.data,
      })
    } else if (ev.kind === 'model_call') {
      totalCalls++
      if (targetStory) targetStory.calls++
      const cost = Number(ev.data?.cost_usd ?? ev.data?.cost ?? 0)
      totalCostUsd += cost
      if (targetStory && (ev.data?.cost_usd != null || ev.data?.cost != null)) {
        targetStory.cost = (targetStory.cost ?? 0) + cost
      }
    }
  }

  // Ler artefatos da missão
  const artifactsDir = path.join(missionDir, 'artifacts')
  /** @type {Array<{ref: string, name: string, size: number}>} */
  const artifacts = []
  if (fs.existsSync(artifactsDir)) {
    /** @param {string} d @param {string} rel */
    const scanDir = (d, rel = '') => {
      const items = fs.readdirSync(d, { withFileTypes: true })
      for (const item of items) {
        const itemRel = path.join(rel, item.name).replace(/\\/g, '/')
        const full = path.join(d, item.name)
        if (item.isDirectory()) {
          scanDir(full, itemRel)
        } else if (item.isFile()) {
          artifacts.push({
            ref: itemRel,
            name: item.name,
            size: fs.statSync(full).size,
          })
        }
      }
    }
    scanDir(artifactsDir)
  }

  // Preencher diffs caso existam arquivos de diff nos artefatos
  for (const s of storyStates.values()) {
    const diffFile = artifacts.find((a) => a.ref.includes(`diff-${s.id}`) || a.ref.includes(`${s.id}.diff`))
    if (diffFile) {
      const raw = fs.readFileSync(path.join(artifactsDir, diffFile.ref), 'utf8')
      s.diff = [{ file: `story-${s.id}.diff`, lines: raw.split('\n').map((l) => [l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c', l]) }]
    }
  }

  const stories = Array.from(storyStates.values())

  return {
    id: missionId,
    digest: planDigest,
    immutable_digest: plan.immutable_digest || planDigest,
    title: plan.intent || plan.briefing?.request,
    intent: plan.intent || plan.briefing?.request,
    autonomy: plan.authorization?.autonomy,
    max_usd: plan.mission_budget?.max_usd,
    consumed_usd: totalCalls > 0 ? totalCostUsd : null,
    total_calls: totalCalls,
    epics,
    stories,
    decisions,
    artifacts,
    events,
  }
}
