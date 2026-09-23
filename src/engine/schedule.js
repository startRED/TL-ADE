// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort } from '../git/gitport.ts'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { openJournal, readJournal } from '../journal/journal.ts'
import { acquireLease } from '../lease/lease.ts'
import { assertApprovedPlan, replanRemaining } from '../mission/plan-lifecycle.js'
import { createStepRunner } from '../step/step.ts'
import { loadPlan } from './plan-load.js'
import { drainMission, readMissionControl, clearControlRequest } from './control.js'
import { readLineageCallBudget } from './resume.js'

/**
 * Retorna as dependências declaradas de uma story, suportando story.depends_on e story.contract.depends_on.
 *
 * @param {any} story
 * @returns {string[]}
 */
export function getStoryDeps(story) {
  return story?.depends_on ?? story?.contract?.depends_on ?? []
}

/**
 * Valida se um estado indica que a story foi concluída.
 *
 * @param {any} state
 * @returns {boolean}
 */
export function isCompleted(state) {
  if (!state) return false
  if (state === 'completed' || state === 'done' || state === 'committed' || state === 'delivered') return true
  if (typeof state === 'object') {
    return (
      state.status === 'completed' ||
      state.status === 'done' ||
      state.status === 'committed' ||
      state.status === 'delivered' ||
      state.state === 'completed' ||
      state.outcome === 'completed'
    )
  }
  return false
}

/**
 * Valida se um estado indica que a story está bloqueada ou falhou.
 *
 * @param {any} state
 * @returns {boolean}
 */
export function isBlocked(state) {
  if (!state) return false
  if (state === 'blocked' || state === 'failed' || state === 'awaiting_operator') return true
  if (typeof state === 'object') {
    return (
      state.status === 'blocked' ||
      state.status === 'failed' ||
      state.status === 'awaiting_operator'
    )
  }
  return false
}

/**
 * Verifica o vínculo de uma story preservada com o contrato canônico carregado.
 * Devolve o motivo da divergência, ou null quando o vínculo é íntegro.
 *
 * @param {any} preserved Entrada de `decision/stories_preserved`.
 * @param {string} status Status declarado na entrada preservada.
 * @param {Map<string, any> | null} storiesById
 * @returns {string | null}
 */
function preservedDivergence(preserved, status, storiesById) {
  if (status !== 'committed' && status !== 'delivered') return 'preserved_status_invalid'
  if (typeof preserved.commit !== 'string' || preserved.commit.length === 0) {
    return 'preserved_commit_missing'
  }
  if (!storiesById) return null
  const story = storiesById.get(preserved.unit)
  // Story preservada que não pertence ao plano carregado não governa nenhum despacho aqui.
  if (!story) return null
  if (typeof preserved.digest !== 'string' || preserved.digest.length === 0) {
    return 'preserved_digest_missing'
  }
  if (digest16(story.contract) !== preserved.digest) return 'preserved_digest_divergent'
  return null
}

/**
 * Deriva os estados de cada story a partir dos eventos duráveis do journal.
 *
 * @param {Array<Record<string, any>>} events
 * @param {Map<string, any> | null} [storiesById] Contratos canônicos carregados, indexados por id.
 *   Quando informado, cada story preservada só vale como concluída se o vínculo (status, commit e
 *   digest) bater com o contrato canônico; divergência estaciona a story em vez de ignorá-la.
 * @returns {Record<string, { status: string, commit?: string | null, reason?: string | null }>}
 */
export function deriveStoryStates(events, storiesById = null) {
  /** @type {Record<string, { status: string, commit?: string | null, reason?: string | null }>} */
  const states = {}
  if (!Array.isArray(events)) return states

  for (const ev of events) {
    if (!ev) continue
    if (ev.kind === 'decision' && ev.data?.decision === 'stories_preserved' && Array.isArray(ev.data?.preserved)) {
      for (const p of ev.data.preserved) {
        if (!p || !p.unit) continue
        const status = p.status || 'delivered'
        const divergence = preservedDivergence(p, status, storiesById)
        states[p.unit] = divergence
          ? { status: 'awaiting_operator', commit: p.commit ?? null, reason: divergence }
          : { status, commit: p.commit ?? null, reason: 'preserved' }
      }
    }
    if (ev.kind === 'story_skipped') {
      const unit = ev.unit || ev.data?.unit
      if (unit) {
        states[unit] = {
          status: 'committed',
          commit: ev.data?.commit ?? null,
          reason: ev.data?.reason ?? null,
        }
      }
    }
    if (ev.kind === 'story_done') {
      const unit = ev.unit || ev.data?.unit
      if (unit) {
        states[unit] = {
          status: ev.data?.status,
          commit: ev.data?.commit ?? null,
          reason: ev.data?.reason ?? null,
        }
      }
    }
  }
  return states
}

/**
 * Valida o grafo de dependências das stories:
 * - Valida unicidade de id
 * - Valida existência das dependências declaradas em depends_on
 * - Detecta ciclos no grafo
 * Lança AdeError com exitCode 2 em caso de violação de integridade.
 *
 * @param {Array<{ id: string, depends_on?: string[] }>} stories
 * @returns {void}
 */
export function validateGraph(stories, satisfiedDeps = new Set()) {
  if (!Array.isArray(stories)) {
    throw new AdeError('invalid_stories_graph', 'stories deve ser um array', 2)
  }

  const ids = new Set()
  for (const story of stories) {
    if (!story || typeof story.id !== 'string' || story.id.length === 0) {
      throw new AdeError('invalid_story_id', 'story com id inválido ou ausente', 2)
    }
    if (ids.has(story.id)) {
      throw new AdeError('duplicate_story_id', `id de story duplicado: ${story.id}`, 2, { id: story.id })
    }
    ids.add(story.id)
  }

  // Valida existência de depends_on
  for (const story of stories) {
    const deps = getStoryDeps(story)
    if (!Array.isArray(deps)) {
      throw new AdeError('invalid_depends_on', `depends_on inválido na story ${story.id}`, 2)
    }
    for (const dep of deps) {
      if (!ids.has(dep) && !satisfiedDeps.has(dep)) {
        throw new AdeError('missing_dependency', `dependência ausente: ${dep}`, 2, { storyId: story.id, missing: dep })
      }
    }
  }

  // Detecção de ciclos via DFS
  const stateMap = new Map()
  for (const id of ids) {
    stateMap.set(id, 0)
  }

  const storyMap = new Map()
  for (const story of stories) {
    storyMap.set(
      story.id,
      getStoryDeps(story).filter((dep) => ids.has(dep)),
    )
  }

  /**
   * @param {string} node
   */
  function dfs(node) {
    stateMap.set(node, 1)
    const deps = storyMap.get(node) || []
    for (const dep of deps) {
      const depState = stateMap.get(dep)
      if (depState === 1) {
        throw new AdeError('cycle_detected', `ciclo de dependências detectado envolvendo: ${node} -> ${dep}`, 2, {
          from: node,
          to: dep,
        })
      }
      if (depState === 0) {
        dfs(dep)
      }
    }
    stateMap.set(node, 2)
  }

  for (const id of ids) {
    if (stateMap.get(id) === 0) {
      dfs(id)
    }
  }
}

/**
 * Seleciona a próxima story pronta para execução respeitando a ordem de dependências e desempate por id.
 *
 * @param {Array<{ id: string, depends_on?: string[] }>} stories
 * @param {Record<string, any>} [states]
 * @returns {{ id: string } | null}
 */
export function nextReady(stories, states = {}) {
  const satisfiedDeps = new Set(
    Object.keys(states).filter((k) => isCompleted(states[k])),
  )
  validateGraph(stories, satisfiedDeps)

  const candidates = []
  for (const story of stories) {
    // Se a story já está concluída, não precisa rodar de novo
    if (isCompleted(states[story.id])) {
      continue
    }

    // Se a própria story está bloqueada ou falhou, ela não está pronta para executar
    if (isBlocked(states[story.id])) {
      continue
    }

    const deps = getStoryDeps(story)
    const allDepsCompleted = deps.every((dep) => isCompleted(states[dep]))
    if (allDepsCompleted) {
      candidates.push(story)
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // Ordena candidatos por id
  candidates.sort((a, b) => a.id.localeCompare(b.id))

  return { id: candidates[0].id }
}

/**
 * Executa todas as stories de um plano em ordem sequencial respeitando dependências,
 * aprovação congelada, retomada após interrupção e replanejamento com no_changes.
 *
 * @param {Record<string, any>} deps
 * @param {Object} input
 * @param {import('./plan-load.js').LoadedPlan} input.loaded
 * @param {string} input.repoDir
 * @param {string} input.missionDir
 * @returns {Promise<{
 *   status: 'completed' | 'awaiting_operator',
 *   exitCode: number,
 *   completedStories: string[],
 *   currentStory?: string,
 *   reason?: string | null,
 *   nextAction?: string,
 * }>}
 */
/**
 * Menor id `S<n>` ainda livre.
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
 * Confere a aprovação durável contra o plano e os contratos carregados.
 *
 * @param {any} deps
 * @param {import('./plan-load.js').LoadedPlan} loadedPlan
 * @param {Array<Record<string, any>>} events
 * @param {string} mDir
 * @returns {{ valid: boolean, reason?: string, storyId?: string, nextAction?: string, approval?: any }}
 */
export function checkApproval(deps, loadedPlan, events, mDir) {
  const approval = events.find(
    (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
  )

  if (!approval) {
    return { valid: false, reason: 'approval_missing', nextAction: 'ade approve' }
  }
  if (deps.skillCatalogError) {
    return { valid: false, reason: 'approval_divergent', nextAction: 'ade catalog sync && ade approve' }
  }
  if (!approval.data?.digest) {
    return { valid: false, reason: 'approval_divergent', nextAction: 'ade approve' }
  }
  if (approval.data.digest !== digest16(loadedPlan.plan)) {
    return { valid: false, reason: 'approval_divergent', nextAction: 'ade approve' }
  }
  const frozenContracts = approval.data?.contract_digests || {}
  const authorization = loadedPlan.plan?.authorization || {}
  if (
    digest16(approval.data?.eligible_skills) !== digest16(authorization.eligible_skills || []) ||
    digest16(approval.data?.permitted_effects) !== digest16(authorization.permitted_effects || [])
  ) {
    return { valid: false, reason: 'approval_divergent', nextAction: 'ade approve' }
  }
  // `assertApprovedPlan` confere os arquivos; aqui se confere o contrato em memória, que é
  // o que de fato vai para o despacho.
  for (const story of loadedPlan.stories || []) {
    if (frozenContracts[story.id] !== digest16(story.contract)) {
      return { valid: false, reason: 'approval_divergent', storyId: story.id, nextAction: 'ade approve' }
    }
  }
  const assertApprovedPlanFn = deps.assertApprovedPlan || assertApprovedPlan
  try {
    assertApprovedPlanFn({
      missionDir: mDir,
      plan: loadedPlan.plan,
      skillSnapshot: deps.eligibleSkillSnapshot || [],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const match = msg.match(/contrato\s+(\S+)\s+alterado/)
    return {
      valid: false,
      reason: 'approval_divergent',
      storyId: match ? match[1] : undefined,
      nextAction: 'ade approve',
    }
  }
  const expectedSummary = digest16({
    plan: approval.data.digest,
    contracts: frozenContracts,
    ...(Array.isArray(approval.data?.eligible_skill_pins) ? { skills: approval.data.eligible_skill_pins } : {}),
  })
  if (approval.data.summary_digest !== expectedSummary) {
    return { valid: false, reason: 'approval_divergent', nextAction: 'ade approve' }
  }
  return { valid: true, approval }
}

/**
 * Executa todas as stories de um plano em ordem sequencial respeitando dependências,
 * aprovação congelada, retomada após interrupção e replanejamento com no_changes.
 *
 * @param {Record<string, any>} deps
 * @param {Object} input
 * @param {import('./plan-load.js').LoadedPlan} input.loaded
 * @param {string} input.repoDir
 * @param {string} input.missionDir
 * @returns {Promise<{
 *   status: 'completed' | 'awaiting_operator' | 'stopped',
 *   exitCode: number,
 *   completedStories: string[],
 *   currentStory?: string,
 *   reason?: string | null,
 *   nextAction?: string,
 *   checkpointRef?: string,
 * }>}
 */
export async function runSequentialMission(deps, { loaded, repoDir, missionDir }) {
  let currentLoaded = loaded
  let currentMissionDir = missionDir

  const replacementJournals = []
  const replacementLeases = []

  /**
   * @param {string} mDir
   * @returns {Array<Record<string, any>>}
   */
  const readEvents = (mDir) => {
    const jPath = path.join(mDir, 'journal.jsonl')
    if (!fs.existsSync(jPath)) return []
    try {
      const res = readJournal(jPath)
      return res.events || []
    } catch (err) {
      if (err instanceof AdeError || (err instanceof Error && err.name === 'JournalCorruptError')) {
        throw err
      }
      throw new AdeError('journal_corrupted', `journal corrompido: ${err instanceof Error ? err.message : String(err)}`, 2)
    }
  }

  /**
   * @param {import('./plan-load.js').LoadedPlan} loadedPlan
   * @param {Array<Record<string, any>>} events
   * @param {string} [mDir]
   */
  const validateApproval = (loadedPlan, events, mDir = currentMissionDir) =>
    checkApproval(deps, loadedPlan, events, mDir)

  let claiming = true
  /**
   * Portão de controle: missão STOPPED não despacha; pausa pedida, DRAINING herdado de um
   * processo que caiu ou sinal de encerramento drenam até STOPPED antes de reivindicar story.
   *
   * @param {string[]} completed
   */
  const controlGate = async (completed) => {
    const ctl = readMissionControl({ missionDir: currentMissionDir })
    const nextAction = 'retomar pelo painel (POST /api/actions/resume)'
    if (ctl.state === 'STOPPED') {
      return { status: /** @type {const} */ ('stopped'), exitCode: 3, completedStories: completed, reason: 'mission_stopped', nextAction }
    }
    const { shutdown, journal } = /** @type {any} */ (deps)
    const shutdownReason = shutdown ? shutdown.reason() : null
    const pauseRequested = ctl.requested_action === 'pause'
    if (ctl.state !== 'DRAINING' && !pauseRequested && !shutdownReason) return null
    if (!journal) throw new AdeError('journal_missing', 'drenagem exige o journal da missão', 4)
    const reason = shutdownReason ?? 'pause'
    const drained = await drainMission({
      journal,
      checkpoint: async () => `journal:${journal.lastSeq}`,
      stopClaiming: () => {
        claiming = false
      },
      reason,
      requestId: pauseRequested ? ctl.request_id : null,
    })
    if (pauseRequested && ctl.request_id) clearControlRequest(currentMissionDir, ctl.request_id)
    return {
      status: /** @type {const} */ ('stopped'),
      exitCode: 3,
      completedStories: completed,
      reason,
      nextAction,
      checkpointRef: drained.checkpoint_ref,
    }
  }

  // 1. Reconciliação inicial de intenções abertas
  if (typeof deps.reconcileAll === 'function') {
    const gitPort = deps.gitPortFor
      ? deps.gitPortFor(repoDir)
      : createGitPort({ worktreeDir: repoDir })
    const journal = deps.journal
    if (journal) {
      const verdicts = await deps.reconcileAll({ journal, missionDir: currentMissionDir, gitPort })
      if (verdicts && verdicts.length > 0) {
        await journal.append({
          kind: 'run_resumed',
          data: {
            verdicts: verdicts.map((/** @type {any} */ v) => ({
              step_id: v.step_id,
              verdict: v.verdict,
              reason: v.reason,
            })),
          },
        })
      }
    }
  }

  const startGate = await controlGate([])
  if (startGate) return startGate

  // 2. Validação da aprovação do plano
  const initialCheck = validateApproval(currentLoaded, readEvents(currentMissionDir))
  if (!initialCheck.valid) {
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      completedStories: [],
      currentStory: initialCheck.storyId,
      reason: initialCheck.reason,
      nextAction: initialCheck.nextAction,
    }
  }

  // Tetos originais da linhagem: o replanejamento troca o plano, mas não renova o orçamento.
  const lineageBudget = readLineageCallBudget({ repoDir, plan: loaded.plan })
  const originalPlanBudget = loaded.plan?.budget
    ? { ...loaded.plan.budget, max_model_calls: lineageBudget.maxModelCalls }
    : null
  const originalMissionBudget = loaded.missionBudget ? { ...loaded.missionBudget } : null
  let lineageCalls = lineageBudget.consumedCalls
  if (typeof originalPlanBudget?.max_model_calls === 'number') {
    currentLoaded.lineageCallsRemaining = Math.max(0, originalPlanBudget.max_model_calls - lineageCalls)
  }

  /** @type {string[]} */
  const completedStories = []
  /**
   * Stories já resolvidas NESTA execução. Uma story concluída antes ainda passa uma vez por
   * `runStory`, que reconhece o resultado anterior com `story_skipped` e devolve sem reserva,
   * pacote, chamada, revisão ou commit novos.
   * @type {Map<string, { status: string, commit: string | null, reason: string | null }>}
   */
  const handled = new Map()

  try {
    while (true) {
    const gate = await controlGate(completedStories)
    if (gate) return gate
    const events = readEvents(currentMissionDir)
    const storiesById = new Map(currentLoaded.stories.map((s) => [s.id, s]))
    const journalStates = deriveStoryStates(events, storiesById)

    const approvalCheck = validateApproval(currentLoaded, events)
    if (!approvalCheck.valid) {
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        completedStories,
        currentStory: approvalCheck.storyId,
        reason: approvalCheck.reason,
        nextAction: approvalCheck.nextAction,
      }
    }

    /** @type {Record<string, any>} */
    const states = {}
    for (const completedId of completedStories) {
      states[completedId] = { status: 'completed' }
    }
    for (const [unit, st] of Object.entries(journalStates)) {
      if (isCompleted(st) && !states[unit]) {
        states[unit] = st
      }
    }
    for (const s of currentLoaded.stories) {
      const journalState = journalStates[s.id]
      if (handled.has(s.id)) states[s.id] = handled.get(s.id)
      else if (journalState && isBlocked(journalState)) states[s.id] = journalState
      else if (!states[s.id]) states[s.id] = undefined
    }

    for (const story of currentLoaded.stories) {
      if (isCompleted(states[story.id]) && !completedStories.includes(story.id)) {
        completedStories.push(story.id)
      }
    }

    // Verifica se todas as stories foram concluídas
    const allCompleted = currentLoaded.stories.every((s) => isCompleted(states[s.id]))
    if (allCompleted) {
      return {
        status: 'completed',
        exitCode: 0,
        completedStories,
      }
    }

    // Seleciona a próxima story pronta
    const next = nextReady(currentLoaded.stories, states)

    if (!next) {
      // Nenhuma story pronta: dependência falha ou bloqueada
      const storyWithBlockedDep = currentLoaded.stories.find((s) => {
        if (isCompleted(states[s.id])) return false
        const deps = getStoryDeps(s)
        return deps.some((dep) => isBlocked(states[dep]))
      })

      if (storyWithBlockedDep) {
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          completedStories,
          currentStory: storyWithBlockedDep.id,
          reason: 'dependency_failed',
          nextAction: 'operator intervention required',
        }
      }

      const uncompleted = currentLoaded.stories.find((s) => !isCompleted(states[s.id]))
      const reason = (uncompleted ? states[uncompleted.id]?.reason : undefined) || 'dependency_blocked'
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        completedStories,
        currentStory: uncompleted?.id,
        reason,
        nextAction: 'operator intervention required',
      }
    }

    const story = currentLoaded.stories.find((s) => s.id === next.id)
    if (!story) {
      throw new Error(`Story ${next.id} não encontrada no plano carregado`)
    }

    if (!claiming) throw new AdeError('scheduler_draining', 'scheduler drenado não reivindica story', 2)
    // Executa a story
    const runStoryFn = deps.runStory || (await import('../engine.js')).runStory
    const storyResult = await runStoryFn(deps, {
      loaded: currentLoaded,
      story,
      repoDir,
      missionDir: currentMissionDir,
    })

    if (storyResult.status === 'committed' || storyResult.status === 'delivered') {
      handled.set(story.id, {
        status: storyResult.status,
        commit: storyResult.commit ?? null,
        reason: storyResult.reason ?? null,
      })
      if (!completedStories.includes(story.id)) {
        completedStories.push(story.id)
      }
      continue
    }

    // Story parou em awaiting_operator
    if (storyResult.reason === 'no_changes') {
      const briefing = currentLoaded.plan?.briefing
      const previousReplanCount = briefing?.replan_count || 0
      const isAlreadyReplanned = Boolean(briefing?.replan_from) || previousReplanCount >= 1

      if (isAlreadyReplanned) {
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          completedStories,
          currentStory: story.id,
          reason: 'no_changes',
          nextAction: 'operator review needed: no changes produced after replan',
        }
      }

      // Limpa worktree da story sem alterações para permitir nova branch na missão replanejada
      const gitPort = deps.gitPortFor
        ? deps.gitPortFor(repoDir)
        : createGitPort({ worktreeDir: repoDir })
      const oldWtDir = path.join(repoDir, '.ade', 'wt', story.id)
      if (fs.existsSync(oldWtDir)) {
        try {
          await gitPort.run(['worktree', 'remove', '--force', oldWtDir], { maxBuffer: 1 << 24 })
        } catch {
          // `worktree remove` recusa worktree com arquivos travados no Windows; a remoção direta
          // seguida de prune é o fallback, e falha dela sobe.
          fs.rmSync(oldWtDir, { recursive: true, force: true })
          await gitPort.run(['worktree', 'prune'], { maxBuffer: 1 << 24 })
        }
      }

      // Replaneja o trabalho restante
      const replanFn = deps.replanRemaining || replanRemaining
      const loadPlanFn = deps.loadPlan || loadPlan
      // Só a story inconclusiva e o fecho transitivo de suas sucessoras pendentes são
      // recompilados: ramo pendente que não depende dela não perde o contrato aprovado.
      const pendingStories = currentLoaded.stories.filter(
        (s) => !completedStories.includes(s.id),
      )
      const affectedIds = new Set([story.id])
      let grew = true
      while (grew) {
        grew = false
        for (const s of pendingStories) {
          if (affectedIds.has(s.id)) continue
          if (getStoryDeps(s).some((dep) => affectedIds.has(dep))) {
            affectedIds.add(s.id)
            grew = true
          }
        }
      }
      const affectedStories = pendingStories.filter((s) => affectedIds.has(s.id))
      const untouchedPending = pendingStories.filter((s) => !affectedIds.has(s.id))

      const request =
        affectedStories.map((s) => s.contract?.task || s.id).join(' e ') ||
        currentLoaded.plan?.intent
      let replanRes
      try {
        replanRes = await replanFn(
          { repoDir, fromMissionId: currentLoaded.plan.mission_id, request },
          deps,
        )
      } catch (err) {
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          completedStories,
          currentStory: story.id,
          reason: 'replan_failed',
          nextAction: `operator review needed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      const newMissionDir = path.join(repoDir, '.ade', 'missions', replanRes.missionId)
      const newStoriesDir = path.join(newMissionDir, 'stories')
      const newPlanPath = path.join(newMissionDir, 'plan.json')
      const oldStoriesDir = path.join(currentMissionDir, 'stories')

      // Resolve colisão entre ids recompilados e ids de ramos preservados/pendentes
      const untouchedIds = new Set(untouchedPending.map((s) => s.id))
      const usedIds = new Set([...completedStories, ...untouchedIds])
      for (const c of replanRes.replannedStories) {
        if (!untouchedIds.has(c.id)) {
          usedIds.add(c.id)
        }
      }
      for (const c of replanRes.replannedStories) {
        if (untouchedIds.has(c.id)) {
          const oldId = c.id
          const newId = nextFreeStoryId(usedIds)
          usedIds.add(newId)
          c.id = newId
          const oldFile = path.join(newStoriesDir, `${oldId}.json`)
          const newFile = path.join(newStoriesDir, `${newId}.json`)
          if (fs.existsSync(oldFile)) {
            const contractData = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
            contractData.id = newId
            if (typeof contractData.title === 'string' && contractData.title.startsWith(oldId)) {
              contractData.title = newId + contractData.title.slice(oldId.length)
            }
            fs.writeFileSync(newFile, JSON.stringify(contractData, null, 2), 'utf8')
            fs.rmSync(oldFile, { force: true })
          }
        }
      }

      // Preserva os contratos pendentes não afetados sem recompilá-los
      if (untouchedPending.length > 0) {
        for (const s of untouchedPending) {
          const srcFile = path.join(oldStoriesDir, `${s.id}.json`)
          const destFile = path.join(newStoriesDir, `${s.id}.json`)
          if (fs.existsSync(srcFile)) {
            fs.copyFileSync(srcFile, destFile)
          } else if (s.contract) {
            fs.writeFileSync(destFile, JSON.stringify(s.contract, null, 2), 'utf8')
          }
        }
        const newPlanObj = JSON.parse(fs.readFileSync(newPlanPath, 'utf8'))
        // O ramo preservado mantém o contrato (e o digest) aprovado, inclusive o `depends_on`
        // para stories já concluídas. Elas entram no plano substituto como preservadas:
        // o journal as marca concluídas por `stories_preserved`, então nunca são despachadas.
        const completedDeps = [...new Set(
          untouchedPending.flatMap((s) => getStoryDeps(s)).filter((dep) => completedStories.includes(dep)),
        )]
        const allPendingIds = [
          ...completedDeps,
          ...untouchedPending.map((s) => s.id),
          ...replanRes.replannedStories.map((/** @type {any} */ c) => c.id),
        ]
        newPlanObj.phases = [{ epics: [{ stories: allPendingIds }] }]
        newPlanObj.immutable_digest = digest16(newPlanObj)
        fs.writeFileSync(newPlanPath, JSON.stringify(newPlanObj, null, 2), 'utf8')
      }

      // O journal da missão substituta nasce vazio: sem transportar o consumo da linhagem,
      // as chamadas já pagas deixariam de contar contra o teto do plano.
      lineageCalls += readEvents(currentMissionDir).filter(
        (e) => e.kind === 'budget_reserved',
      ).length

      currentMissionDir = newMissionDir
      currentLoaded = loadPlanFn(newPlanPath)

      if (originalMissionBudget) {
        currentLoaded.missionBudget = { ...originalMissionBudget }
      }
      // O plano substituto fica intacto para a aprovação cobrir o arquivo exato; o teto da
      // linhagem viaja fora dele e o motor usa o menor dos dois.
      if (typeof originalPlanBudget?.max_model_calls === 'number') {
        currentLoaded.lineageCallsRemaining = Math.max(0, originalPlanBudget.max_model_calls - lineageCalls)
      }

      // A missão replanejada exige aprovação durável conforme o fluxo definido antes de despachar contratos.
      // Se a autorização foi ampliada além do congelado pelo operador, exige `ade approve` explícito.
      const frozenAuth = loaded.plan?.authorization || {}
      const newAuth = currentLoaded.plan?.authorization || {}
      const widened = [
        ...(newAuth.permitted_effects || []).filter((/** @type {string} */ e) => !(frozenAuth.permitted_effects || []).includes(e)),
        ...(newAuth.eligible_skills || []).filter((/** @type {string} */ s) => !(frozenAuth.eligible_skills || []).includes(s)),
      ]
      if (widened.length > 0) {
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          completedStories,
          currentStory: story.id,
          reason: 'approval_missing',
          nextAction: `ade approve (replanejamento amplia a autorização: ${widened.join(', ')})`,
        }
      }

      const runtimeStamp = deps.runtimeStamp || deps.journal?.runtimeStamp
      if (!runtimeStamp) {
        throw new AdeError('runtime_stamp_missing', 'runtimeStamp é obrigatório nas dependências do scheduler', 4)
      }

      const acquireLeaseFn = deps.acquireLease || acquireLease
      if (typeof acquireLeaseFn === 'function') {
        const replanLease = await acquireLeaseFn({
          missionDir: newMissionDir,
          adoptDeadOwnerWithinTtl: true,
          ttlMs: 15_000,
        })
        replacementLeases.push(replanLease)
      }

      if (deps.journal && typeof deps.journal.close === 'function') {
        await deps.journal.close()
        const newJournal = openJournal({
          missionDir: currentMissionDir,
          runtimeStamp,
        })
        replacementJournals.push(newJournal)
        deps.journal = newJournal
        const { step } = createStepRunner({ journal: deps.journal, missionDir: currentMissionDir })
        deps.step = step
      }
      continue
    }

    return {
      status: 'awaiting_operator',
      exitCode: storyResult.exitCode || 3,
      completedStories,
      currentStory: story.id,
      reason: storyResult.reason,
    }
  }
  } finally {
    // Quem abriu o journal e o lease da missão substituta os fecha; falha aqui sobe.
    for (const l of replacementLeases) await l.release()
    for (const j of replacementJournals) await j.close()
  }
}
