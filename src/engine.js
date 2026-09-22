// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from './journal/errors.js'
import { readJournal } from './journal/journal.js'
import { assertCallBudget, authorizePaidCall, checkUsdCap, DEFAULT_CONTEXT_LIMIT_BYTES, observedUsd, reserveCalls } from './engine/budget.js'
import { deliverStory, withDeliveryFlag } from './engine/deliver.js'
import { authorizedStep } from './engine/paid-call.js'
import { maybeEngineFault } from './engine/faults.js'
import { findStoryCommitted, findStoryStarted } from './engine/resume.js'
import { dedupStorySection } from './pack/dedup.js'
import { measurePackBytes, telemetrySections } from './pack/pack.js'
import { buildStoryContext, guardStoryContext } from './context/story.js'
import { dispatchClaude } from './adapters/claude/index.js'
import { dispatchCodex } from './adapters/codex/index.js'
import { runFrontendQuality } from './visual/evaluate.js'
import { createDesignToolServer } from './visual/design-server.js'
export { nextReady, runSequentialMission } from './engine/schedule.js'

/**
 * Calcula o digest canônico dos insumos observados pelo runtime após contain/execução.
 *
 * @param {{ tree: string, changedPaths?: string[], contractRevision?: string }} opts
 * @returns {string}
 */
export function computeObservedInputDigest({ tree, changedPaths, contractRevision }) {
  const normalizedPaths = (changedPaths ?? []).slice().sort()
  const payload = [
    tree,
    contractRevision ?? '',
    ...normalizedPaths,
  ].join(':')
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}
import {
  buildReviewHandoff,
  computeFindingsDigest,
  detectUnresolvedFindings,
  normalizeFinding,
  isBlockingFinding,
} from './review/handoff.js'
import { isReviewApproved } from './review/validate.js'
import { buildModelTelemetry, modelsFromUsage } from './telemetry/telemetry.js'

/**
 * Famílias de modelos com canário aprovado no Slice 1 e v0.2.
 *
 * @type {readonly string[]}
 */
export const CANARY_FAMILIES = ['claude', 'codex']

/**
 * Composição do pack para a telemetria. Manifesto sem a lista de seções (compilador sem
 * detalhamento) vira uma seção única `pack` com o total medido, para a soma continuar fechando.
 *
 * @param {any} manifest
 */
function packTelemetry(manifest) {
  if (Array.isArray(manifest?.sections)) return { sections: telemetrySections(manifest), bytes: manifest.bytes }
  return { sections: [{ section: 'pack', bytes: manifest.bytes, digest: String(manifest.digest ?? '') }], bytes: manifest.bytes }
}

/**
 * Orquestra o ciclo durável de execução de uma story.
 *
 * @param {Object} deps Dependências injetáveis do motor.
 * @param {{ append: (event: Record<string, unknown>) => Promise<Record<string, unknown>> }} deps.journal Instância do journal aberto.
 * @param {(spec: { unit: string, id: string, effect_class: string, input: unknown }, effectFn: () => Promise<unknown>) => Promise<{ step_id: string, status: string, result: unknown, reused: boolean }>} deps.step Executor de steps com journaling.
 * @param {(dir: string) => import('./git/gitport.js').GitPort} deps.gitPortFor Fábrica de porta git para o diretório de worktree.
 * @param {(opts: { repoDir: string, missionId: string, storyId: string }) => Promise<any>} deps.prepareStory Prepara a worktree e branch.
 * @param {(opts: { step: any, missionDir: string, gitPort: any }) => { runEval: (opts: any) => Promise<any> }} deps.createEvalRunner Fábrica de executor de evals.
 * @param {(opts: { step: any, missionDir: string, gitPort: any, packageJson?: any }) => { runGates: (opts: any) => Promise<any> }} deps.createGateRunner Fábrica de executor de gates.
 * @param {(opts: any) => { pack_path: string, manifest_path: string, manifest: any }} deps.compilePack Compilador do Context Pack.
 * @param {(opts: any) => Promise<any>} deps.contain Executor de contenção de diff e árvore.
 * @param {(opts: { worktreeDir: string, outsideDir: string, unitId: string }) => Promise<any> | any} deps.plantCanary Planta canário fora do worktree.
 * @param {(canary: any) => Promise<any> | any} deps.checkCanary Verifica se o canário foi violado.
 * @param {(opts: any) => Promise<any>} deps.dispatchClaude Despacha execução do modelo para o Maker.
 * @param {(opts: any) => Promise<any>} [deps.dispatchCodex] Despacha execução do modelo para o Checker.
 * @param {{ exe: string, prefixArgs: string[] } | null} [deps.checkerResolved] Binário da família do Checker; `null` quando a fiação não o encontrou.
 * @param {any} [deps.reconcileAll] Reconciliador de intenções abertas.
 * @param {{ exe: string, prefixArgs: string[] }} deps.resolved Binário resolvido e prefixos.
 * @param {Record<string, string>} deps.workerEnv Variáveis de ambiente para o worker.
 * @param {{ probe_ok: boolean | null }} deps.capabilities Estado da sonda de capacidades do doctor.
 * @param {NodeJS.ProcessEnv} [deps.env] Variáveis de ambiente da execução.
 * @param {() => number} [deps.now] Provedor de timestamp atual em ms.
 * @param {{ readReceipt: ({ family, now }: { family: string, now: number }) => Promise<any> }} deps.quotaPort Porta de recibos oficiais de cota.
 * @param {(opts: { story: any, loaded: any, repoDir: string, events: any[] }) => Promise<{ ready: boolean, checks: any[], failures: any[], calls_avoided: number }>} [deps.preflight] Verificador de preflight.
 *
 * @param {Object} input Parâmetros de entrada da story e do plano.
 * @param {import('./engine/plan-load.js').LoadedPlan} input.loaded Plano e contratos carregados.
 * @param {import('./engine/plan-load.js').LoadedStory} input.story Story a ser executada.
 * @param {string} input.repoDir Diretório raiz do repositório alvo.
 * @param {string} input.missionDir Diretório de trabalho da missão em .ade/missions/<mission_id>.
 *
 * @returns {Promise<{ status: 'committed' | 'delivered' | 'awaiting_operator', exitCode: 0 | 3, reason: string | null, commit: string | null, delivered: boolean }>}
 */
export async function runStory(deps, input) {
  const result = await runStoryImpl({ ...deps, journal: withDeliveryFlag(deps.journal) }, input)
  return { ...result, delivered: result.status === 'delivered' }
}

/**
 * @param {any} deps
 * @param {any} input
 * @returns {Promise<{ status: 'committed' | 'delivered' | 'awaiting_operator', exitCode: 0 | 3, reason: string | null, commit: string | null }>}
 */
async function runStoryImpl(deps, input) {
  const { loaded, story, repoDir, missionDir } = input
  const journal = deps.journal
  const missionId = loaded.plan.mission_id
  const storyId = story.id
  const contract = story.contract
  const env = deps.env ?? process.env

  if (typeof deps.preflight !== 'function') {
    throw new AdeError('preflight_missing', 'preflight obrigatório não configurado', 4)
  }

  // Guardas iniciais antes de qualquer step
  const makerFamily = contract.roles?.maker?.family
  const makerModel = contract.roles?.maker?.model_id
  if (!makerFamily || !CANARY_FAMILIES.includes(makerFamily)) {
    throw new AdeError('family_without_canary', `família sem canário aprovado: ${makerFamily}`, 4)
  }

  const checkerRole = contract.roles?.checker_round
  if (checkerRole) {
    if (!checkerRole.family || !CANARY_FAMILIES.includes(checkerRole.family)) {
      throw new AdeError('family_without_canary', `família sem canário aprovado: ${checkerRole.family}`, 4)
    }
    if (checkerRole.family === makerFamily || checkerRole.model_id === makerModel) {
      throw new AdeError('same_family_review_is_refused', 'Maker e Checker não podem pertencer à mesma família ou vendor', 4)
    }
    if (checkerRole.sandbox && checkerRole.sandbox !== 'read-only') {
      throw new AdeError('checker_has_write_permission', 'Checker não pode ter permissão de escrita; esperado sandbox read-only', 4)
    }
  }

  if (!deps.quotaPort || typeof deps.quotaPort.readReceipt !== 'function') {
    throw new AdeError('quota_port_missing', 'porta de cota obrigatória não configurada', 4)
  }

  const probeOk = deps.capabilities?.probe_ok
  if (probeOk === false) {
    throw new AdeError('probe_failed', 'sonda do doctor falhou', 4)
  }
  if (probeOk === null && env.CI !== 'true') {
    throw new AdeError('probe_unverified', 'rode ade doctor com sonda real', 4)
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  const readEvents = () => {
    const res = readJournal(journalPath)
    return res.events || []
  }

  // Anexa batch_open se ausente
  const initialEvents = readEvents()
  const committed = findStoryCommitted(initialEvents, storyId)
  if (committed !== null) {
    await deps.journal.append({
      kind: 'story_skipped',
      unit: storyId,
      data: {
        unit: storyId,
        reason: 'already_committed',
        commit: committed.commit,
      },
    })
    return {
      status: 'committed',
      exitCode: 0,
      reason: 'already_committed',
      commit: committed.commit,
    }
  }

  const hasBatchOpen = initialEvents.some((e) => e.kind === 'batch_open')
  if (!hasBatchOpen) {
    await deps.journal.append({
      kind: 'batch_open',
      data: {
        plan_id: loaded.plan.id,
        mission_budget: loaded.missionBudget,
        spec_revision: story.spec_revision,
      },
    })
  }

  // Verificação de preflight antes de reservar chamadas ou preparar worktree
  const preflight = await deps.preflight({
    story,
    loaded,
    repoDir,
    events: readEvents(),
  })

  await deps.journal.append({
    kind: 'preflight_result',
    unit: storyId,
    data: {
      status: preflight.ready ? 'ready' : 'blocked',
      checks: preflight.checks,
      failures: preflight.failures,
      calls_avoided: preflight.calls_avoided,
    },
  })

  if (!preflight.ready) {
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: 'preflight',
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: 'preflight',
      commit: null,
    }
  }

  // Autoriza e reserva a chamada paga antes de preparar a worktree.
  assertCallBudget(loaded.plan.budget, 'plan')
  assertCallBudget(contract.budget, 'contract')
  // Contrato acima do teto ou verificador sem comando recusam a story antes de reservar cota.
  const contextGuard = guardStoryContext({ story, contract, workspaceDir: repoDir })
  if (contextGuard.status !== 'ready') {
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: contextGuard.reason,
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: contextGuard.reason,
      commit: null,
    }
  }

  const dedup = dedupStorySection(story)
  // O pack só é montado depois do worktree preparado; aqui medimos o contexto para a reserva.
  const baseSections = {
    contract: typeof contract === 'string' ? contract : JSON.stringify(contract, null, 2),
    policy: JSON.stringify(loaded.plan.authorization ?? {}, null, 2),
    story: dedup.text,
    skills: '',
  }
  const contextBytes = measurePackBytes(baseSections)
  const eventsBeforeReservation = readEvents()
  const previousReservation = eventsBeforeReservation.find((event) => {
    const data = event.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const reservationData = /** @type {Record<string, unknown>} */ (data)
    return event.kind === 'budget_reserved' &&
      (event.unit === storyId || reservationData.unit === storyId) &&
      reservationData.quota_receipt
  })
  const previousReservationData = previousReservation?.data
  const previousQuotaReceipt = previousReservationData &&
    typeof previousReservationData === 'object' &&
    !Array.isArray(previousReservationData)
    ? /** @type {Record<string, unknown>} */ (previousReservationData).quota_receipt
    : undefined
  const quotaReceipt = previousQuotaReceipt ?? await deps.quotaPort.readReceipt({
    family: makerFamily,
    now: deps.now?.() ?? Date.now(),
  })
  const hasPreviousReservation = Boolean(previousReservation)
  // Teto efetivo da chamada: o menor entre o teto da missão e o do contrato. A reserva é o que o
  // despacho leva ao modelo, então reservar só o teto do contrato deixaria gastar acima da missão.
  const usdCaps = [contract.budget?.max_usd, loaded.missionBudget.max_usd].filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  )
  if (usdCaps.length === 0) {
    throw new AdeError('invalid_budget_reservation', 'missão e contrato sem max_usd', 4)
  }
  const requestedUsd = hasPreviousReservation ? 0 : Math.min(...usdCaps)
  const effectiveMaxCalls = Math.min(
    loaded.plan.budget.max_model_calls,
    contract.budget.max_model_calls,
    loaded.lineageCallsRemaining ?? Infinity,
  )
  const makerBudgetEvents = eventsBeforeReservation.filter((event) => {
    const stepId = event.step_id ?? event.data?.step_id
    return event.kind !== 'step_result' || typeof stepId !== 'string' || stepId.endsWith(':maker')
  })
  const paidCall = authorizePaidCall({
    events: makerBudgetEvents,
    observed_usd: observedUsd(eventsBeforeReservation).observed_usd,
    mission_budget: {
      ...loaded.missionBudget,
      // `authorizePaidCall` inclui a reserva prospectiva e usa limite exclusivo.
      max_model_calls: Number.isFinite(effectiveMaxCalls) ? effectiveMaxCalls + 1 : undefined,
      max_usd: undefined,
    },
    story_budget: {
      ...contract.budget,
      max_model_calls: Number.isFinite(effectiveMaxCalls) ? effectiveMaxCalls + 1 : undefined,
    },
    family: makerFamily,
    phase: 'implementation',
    requested_calls: hasPreviousReservation ? 0 : (contract.needs_ui ? 2 : 1),
    requested_usd: requestedUsd,
    requested_turns: hasPreviousReservation ? 0 : 1,
    context_bytes: contextBytes,
    quota_receipt: quotaReceipt,
    now: deps.now?.() ?? Date.now(),
  })

  if (!paidCall.allowed) {
    if (paidCall.reason === 'quota_unavailable' || paidCall.reason === 'quota_untrusted') {
      await deps.journal.append({
        kind: 'operational_block',
        unit: storyId,
        data: {
          reason: paidCall.reason,
          ready_for_autonomous_dispatch: false,
          fabricated_percent: null,
        },
      })
    }
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: paidCall.reason,
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: paidCall.reason,
      commit: null,
    }
  }

  const maxModelCalls = effectiveMaxCalls
  const reservation = reserveCalls({
    events: readEvents(),
    storyId,
    maxModelCalls,
  })

  if (reservation.reason === 'exhausted') {
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: 'budget_calls_exhausted',
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: 'budget_calls_exhausted',
      commit: null,
    }
  }

  if (reservation.reason === 'reserved') {
    await deps.journal.append({
      kind: 'budget_reserved',
      unit: storyId,
      data: {
        calls: paidCall.reservation.calls,
        usd: paidCall.reservation.usd,
        turns: paidCall.reservation.turns,
        family: paidCall.reservation.family,
        phase: 'implementation',
        quota_receipt: quotaReceipt,
        unit: storyId,
      },
    })
  }

  const authorizedReservation = hasPreviousReservation
    ? {
        calls: /** @type {Record<string, any>} */ (previousReservationData).calls,
        usd: /** @type {Record<string, any>} */ (previousReservationData).usd,
        turns: /** @type {Record<string, any>} */ (previousReservationData).turns,
        family: /** @type {Record<string, any>} */ (previousReservationData).family,
      }
    : paidCall.reservation

  /** @type {string} */
  let worktreeDir
  /** @type {import('./git/gitport.js').GitPort} */
  let wtPort
  /** @type {string} */
  let treeBefore
  const basePort = deps.gitPortFor(repoDir)
  /** @type {string | null} */
  let baseRef = null
  /** @type {string | null} */
  let baseBefore = null

  const started = findStoryStarted(readEvents(), storyId)
  if (started && fs.existsSync(started.worktree_dir)) {
    worktreeDir = started.worktree_dir
    treeBefore = started.tree_before
    baseRef = started.base_ref
    baseBefore = started.base_before
    wtPort = deps.gitPortFor(worktreeDir)
    await deps.journal.append({
      kind: 'story_resumed',
      unit: storyId,
      data: {
        unit: storyId,
        reason: 'story_started_in_journal',
        worktree_dir: worktreeDir,
        tree_before: treeBefore,
      },
    })
  } else {
    // Sem headInfo não há base observável: a story roda e fica sem alvo de fast-forward,
    // em vez de a entrega escolher uma base calada (mesmo guarda de reconcileLocalMerge).
    const baseHead = typeof basePort.headInfo === 'function'
      ? await basePort.headInfo()
      : { branch: null, commit: null }
    baseRef = baseHead.branch
    baseBefore = baseHead.commit

    // Step prepare
    const prepareStepResult = await deps.step(
      {
        unit: storyId,
        id: `${storyId}:prepare`,
        effect_class: 'prepare',
        input: { storyId, missionId },
      },
      () => deps.prepareStory({ repoDir, missionId, storyId, contract }),
    )

    const prepResult = /** @type {any} */ (prepareStepResult.result)
    if (prepResult.status !== 'ready') {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: prepResult.reason ?? null,
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: prepResult.reason ?? null,
        commit: null,
      }
    }

    worktreeDir = prepResult.worktreeDir
    wtPort = deps.gitPortFor(worktreeDir)
    treeBefore = await wtPort.worktreeTree()

    await deps.journal.append({
      kind: 'story_started',
      unit: storyId,
      data: {
        unit: storyId,
        worktree_dir: worktreeDir,
        tree_before: treeBefore,
        base_ref: baseRef,
        base_before: baseBefore,
      },
    })
  }

  // A descoberta que vale é a do workspace preparado: reconfere os verificadores contra ele antes
  // de montar contexto ou despachar qualquer agente (a guarda anterior já barrou o que dava na base).
  const preparedGuard = guardStoryContext({ story, contract, workspaceDir: worktreeDir })
  if (preparedGuard.status !== 'ready') {
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: preparedGuard.reason,
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: preparedGuard.reason,
      commit: null,
    }
  }

  // Contexto compacto da story: montado só agora, sobre a árvore e os comandos reais do worktree.
  const storyContext = await buildStoryContext(
    { loaded, story, worktreeDir, missionDir, operatorNotes: deps.operatorNotes },
    { journal: deps.journal, eligibleSkills: deps.eligibleSkills, ir: deps.ir },
  )
  const contextStorySection = storyContext.sections.story
  // O que a dedup economizou é medido contra a seção que de fato vai no pack.
  const contextSavedBytes = Math.max(
    0,
    dedup.saved_bytes + Buffer.byteLength(dedup.text) - Buffer.byteLength(contextStorySection),
  )
  const packResult = deps.compilePack({
    missionDir,
    stepId: `${storyId}:r1:maker`,
    sections: { ...baseSections, story: contextStorySection, skills: storyContext.sections?.skills || '' },
    savedBytes: contextSavedBytes,
    skills: storyContext.selectedSkills.map((s) => ({
      name: s.name,
      source: s.source,
      sha256: s.sha256,
      bytes: s.bytes,
    })),
    artifactRefs: storyContext.artifactRefs,
  })

  // O pack montado é o que vai ao modelo: acima do limite de contexto, ninguém é despachado.
  const packBytes = packResult.manifest?.bytes
  if (typeof packBytes !== 'number' || !Number.isSafeInteger(packBytes) || packBytes < 0) {
    throw new AdeError('invalid_pack_manifest', 'manifesto do pack sem tamanho de contexto válido', 4)
  }
  if (packBytes >= DEFAULT_CONTEXT_LIMIT_BYTES) {
    await deps.journal.append({
      kind: 'story_done',
      unit: storyId,
      data: {
        status: 'awaiting_operator',
        reason: 'context_limit_exceeded',
        unit: storyId,
        commit: null,
      },
    })
    return {
      status: 'awaiting_operator',
      exitCode: 3,
      reason: 'context_limit_exceeded',
      commit: null,
    }
  }

  const redGitPort = started
    ? {
        ...wtPort,
        worktreeTree: async () => treeBefore,
      }
    : wtPort

  const { runEval: runRedEval } = deps.createEvalRunner({
    step: deps.step,
    missionDir,
    gitPort: redGitPort,
  })

  // Eval vermelho
  for (const evalDef of story.evals) {
    const evalRecord = await runRedEval({
      eval: evalDef,
      phase: 'red',
      tree: treeBefore,
      unit: storyId,
    })
    if (evalRecord.verdict !== 'red' && evalRecord.verdict !== 'red_valid') {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'eval_red_not_red',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'eval_red_not_red',
        commit: null,
      }
    }
  }

  await deps.journal.append({
    kind: 'pack_manifest',
    unit: storyId,
    data: packResult.manifest,
  })

  let round = 1
  const maxReworkRounds = contract.budget?.max_rework_rounds ?? 2
  let previousFindingsDigest = null
  let previousFindings = []
  let openFindings = []
  let treeBeforeRound = treeBefore

  while (true) {
    let currentPackPath = packResult.pack_path
    let currentManifest = packResult.manifest
    if (round > 1) {
      const reworkHandoff = buildReviewHandoff({
        storyId,
        contractRevision: /** @type {any} */ (story).contract_revision ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        treeBase: treeBefore,
        openFindings,
        deltas: [{ kind: 'changed', ref: `file:${storyId}` }],
        round,
        notes: `rework round ${round}`,
      })
      const storySection = dedupStorySection(/** @type {any} */ ({
        ...story,
        handoff: reworkHandoff,
      }))
      const reworkPack = deps.compilePack({
        sections: {
          contract: JSON.stringify(contract),
          policy: 'rework',
          story: storySection.text,
        },
        missionDir,
        stepId: `${storyId}:r${round}:pack`,
      })
      currentPackPath = reworkPack.pack_path
      currentManifest = reworkPack.manifest
    }

    // Canário fora da worktree
    const canary = await deps.plantCanary({
      worktreeDir,
      outsideDir: path.join(missionDir, `canary-r${round}`),
      unitId: storyId,
    })

    maybeEngineFault('before_spawn', env)

    const resultFile = path.join(missionDir, `maker-result-r${round}.json`)
    const workerEnv = {
      ...deps.workerEnv,
      ...(deps.workerEnv && !deps.workerEnv.ADE_FAKE_RESULT_FILE
        ? { ADE_FAKE_RESULT_FILE: resultFile }
        : {}),
    }

    const makerStartedAt = deps.now?.() ?? Date.now()
    /** @type {import('./engine/paid-call.js').PaidCallAuthorization} */
    const paidAuthorization = {
      authorized: true,
      family: makerFamily,
      phase: round === 1 ? 'implementation' : 'rework',
      reservation: authorizedReservation,
      quota_receipt: quotaReceipt,
      context_bytes: contextBytes,
      weekly_percent_cap: loaded.missionBudget.max_subscription_weekly_percent ?? 50,
    }

    let designServer = null
    let mcpConfigPath
    if (contract.needs_ui) {
      try {
        designServer = await createDesignToolServer({
          toolNames: ['recommend_design', 'compare_design', 'slop_test', 'pre_critique'],
        })
        mcpConfigPath = path.join(missionDir, `design-tools-r${round}.json`)
        fs.writeFileSync(mcpConfigPath, JSON.stringify({
          mcpServers: { ade_design: { type: 'http', url: designServer.url } },
        }), 'utf8')
        await deps.journal.append({
          kind: 'mcp_manifest',
          unit: storyId,
          data: designServer.manifest,
        })
      } catch (err) {
        await deps.journal.append({ kind: 'story_done', unit: storyId, data: { status: 'awaiting_operator', reason: 'fqe_unavailable', error: err instanceof Error ? err.message : String(err) } })
        return { status: 'awaiting_operator', exitCode: 3, reason: 'fqe_unavailable', commit: null }
      }
    }

    let makerDurationMs = 0
    /** @type {(dispatch: any, outcome: 'ok' | 'rework' | 'park' | 'stop') => Promise<void>} */
    const appendMakerTelemetry = (dispatch, outcome) => deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: `${storyId}:r${round}:maker`,
        family: 'claude',
        role: 'maker',
        effort: 'default',
        models: modelsFromUsage(dispatch?.usage?.models ?? [], makerModel ?? null),
        duration_ms: dispatch === undefined ? Math.max(0, (deps.now?.() ?? Date.now()) - makerStartedAt) : makerDurationMs,
        tokens: dispatch?.tokens ?? { source: 'unavailable' },
        usage: dispatch?.usage,
        pack: packTelemetry(currentManifest),
        skills: currentManifest.skills ?? [],
        sources: dispatch?.unit_result?.sources ?? [],
        outcome,
        ttft_ms: null,
        approval_decisions: 0,
        network_attempts: 0,
        files_touched: 0,
        tool_output_raw_bytes: 0,
        tool_output_model_bytes: 0,
      }),
    })

    /** @type {any} */
    let dispatch
    try {
      dispatch = await deps.dispatchClaude({
        // O bloqueio da chamada paga fica no `step()` write-ahead: o efeito `model_call` só chega ao
        // spawn se o teto despachado for exatamente a reserva autorizada.
        step: authorizedStep(
          deps.step,
          paidAuthorization,
          deps.now?.() ?? Date.now(),
        ),
        authorization: paidAuthorization,
        unit: storyId,
        stepId: `${storyId}:r${round}:maker`,
        packPath: currentPackPath,
        missionDir,
        missionId,
        cwd: worktreeDir,
        resultFile,
        maxBudgetUsd: authorizedReservation.usd,
        resolved: deps.resolved,
        env: workerEnv,
        mcpConfigPath,
      })
    } catch (err) {
      await appendMakerTelemetry(undefined, 'stop')
      throw err
    } finally {
      if (designServer) {
        await designServer.close()
      }
    }
    makerDurationMs = Math.max(0, (deps.now?.() ?? Date.now()) - makerStartedAt)

    maybeEngineFault('after_maker_effect', env)

    maybeEngineFault('before_contain', env)

    const tree = await wtPort.worktreeTree()
    const scopePaths = contract.guardrails?.scope_paths ?? []
    const doNotTouch = contract.guardrails?.do_not_touch ?? []
    const sensitivePaths = contract.guardrails?.sensitive_paths ?? []

    const containStepId = round === 1 ? `${storyId}:contain` : `${storyId}:r${round}:contain`
    const containStepResult = await deps.step(
      {
        unit: storyId,
        id: containStepId,
        effect_class: 'none',
        input: { tree },
      },
      () =>
        deps.contain({
          git: wtPort,
          unitId: storyId,
          treeBefore,
          scopePaths,
          doNotTouch,
          sensitivePaths,
        }),
    )

    const containResult = /** @type {any} */ (containStepResult.result)
    await deps.journal.append({
      kind: 'contain_result',
      unit: storyId,
      data: containResult,
    })

    const canaryResult = await deps.checkCanary(canary)
    if (canaryResult.escaped) {
      await appendMakerTelemetry(dispatch, 'park')
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'canary_escaped',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'canary_escaped',
        commit: null,
      }
    }

    if (!containResult.ok) {
      await appendMakerTelemetry(dispatch, 'park')
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: containResult.reason,
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: containResult.reason,
        commit: null,
      }
    }

    const changedPaths = containResult.changedPaths ?? []

    if (round > 1 && previousFindings.length > 0) {
      const unresolvedCheck = detectUnresolvedFindings({
        previousFindings,
        treeBeforeRework: treeBeforeRound,
        treeAfterRework: tree,
        changedFiles: changedPaths,
      })
      if (unresolvedCheck.unresolved) {
        await appendMakerTelemetry(dispatch, 'park')
        await deps.journal.append({
          kind: 'story_done',
          unit: storyId,
          data: {
            status: 'awaiting_operator',
            reason: 'unresolved_blocking_findings',
            unit: storyId,
            commit: null,
          },
        })
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          reason: 'unresolved_blocking_findings',
          commit: null,
        }
      }
    }

    await appendMakerTelemetry(dispatch, round > 1 ? 'rework' : 'ok')

    const usdCap = checkUsdCap({
      observed_usd: observedUsd(readEvents()).observed_usd,
      max_usd: loaded.missionBudget.max_usd,
    })
    if (!usdCap.ok) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'budget_usd_exceeded',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'budget_usd_exceeded',
        commit: null,
      }
    }

    maybeEngineFault('after_contain', env)

    // Gates
    const { runGates } = deps.createGateRunner({
      step: deps.step,
      missionDir,
      gitPort: wtPort,
    })

    const treeAfterContain = await wtPort.worktreeTree()

    const gateRes = await runGates({
      gates: loaded.gates ?? [],
      flags: [],
      tree: treeAfterContain,
      unit: storyId,
      changedFiles: changedPaths,
    })

    await deps.journal.append({
      kind: 'gates_done',
      unit: storyId,
      data: {
        results: gateRes.results,
      },
    })

    const gateFailed =
      !gateRes.ok ||
      gateRes.results.some(
        // `buildExtract` classifica o gate verde como `success`; `passed`/`ok` são as formas
        // antigas e continuam aceitas para journal já gravado.
        (/** @type {any} */ r) => r.status !== 'success' && r.status !== 'passed' && r.status !== 'ok',
      )
    if (gateFailed) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'gate_failed',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'gate_failed',
        commit: null,
      }
    }

    // Eval verde
    const { runEval: runGreenEval } = deps.createEvalRunner({
      step: deps.step,
      missionDir,
      gitPort: wtPort,
    })

    const executedEvalRefs = []
    for (let evalIdx = 0; evalIdx < story.evals.length; evalIdx++) {
      const evalDef = story.evals[evalIdx]
      const evalId = evalDef.id ?? `E${evalIdx + 1}`
      executedEvalRefs.push(evalId)
      const evalRecord = await runGreenEval({
        eval: { ...evalDef, id: evalId },
        phase: 'green',
        tree: treeAfterContain,
        unit: storyId,
      })
      if (evalRecord.verdict !== 'green') {
        await deps.journal.append({
          kind: 'story_done',
          unit: storyId,
          data: {
            status: 'awaiting_operator',
            reason: 'eval_green_failed',
            unit: storyId,
            commit: null,
          },
        })
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          reason: 'eval_green_failed',
          commit: null,
        }
      }
    }

    // Portão do Frontend Quality Engine (FQE) entre gates/evals e Checker
    if (contract.needs_ui) {
      const fqeStepResult = await deps.step(
        {
          unit: storyId,
          id: round === 1 ? `${storyId}:visual_eval` : `${storyId}:r${round}:visual_eval`,
          effect_class: 'none',
          input: { tree: treeAfterContain, round },
        },
        () =>
          (deps.runFrontendQuality ?? runFrontendQuality)({
            story: {
              ...story,
              worktreeDir,
              design_brief: loaded.plan?.briefing?.design_briefs?.[storyId],
            },
            tree: treeAfterContain,
            config: loaded.config ?? {},
            capabilities: deps.capabilities ?? {},
            round: /** @type {1 | 2} */ (round),
            missionDir,
            deps,
          }),
      )

      const fqeRes = /** @type {any} */ (fqeStepResult.result)
      await deps.journal.append({
        kind: 'visual_eval_done',
        unit: storyId,
        data: {
          round,
          status: fqeRes.status,
          reason: fqeRes.reason,
          evaluation: fqeRes.evaluation,
          defects: fqeRes.defects,
        },
      })

      if (fqeRes.status === 'awaiting_operator') {
        await deps.journal.append({
          kind: 'story_done',
          unit: storyId,
          data: {
            status: 'awaiting_operator',
            reason: fqeRes.reason ?? 'visual_cut_not_met',
            unit: storyId,
            commit: null,
            evaluation: fqeRes.evaluation,
          },
        })
        return {
          status: 'awaiting_operator',
          exitCode: 3,
          reason: fqeRes.reason ?? 'visual_cut_not_met',
          commit: null,
        }
      }

      if (fqeRes.status === 'rework') {
        const visualFindings = (fqeRes.defects || []).map((d) => ({
          severity: d.severity,
          message: `${d.criterion}: ${d.fix} (${d.where})`,
          path: d.where,
        }))
        if (round >= 2 || round > maxReworkRounds) {
          await deps.journal.append({ kind: 'story_done', unit: storyId, data: { status: 'awaiting_operator', reason: 'visual_cut_not_met', unit: storyId, commit: null } })
          return { status: 'awaiting_operator', exitCode: 3, reason: 'visual_cut_not_met', commit: null }
        }
        openFindings = visualFindings
        previousFindings = visualFindings
        round++
        continue
      }
    }

    if (!checkerRole) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'no_checker_family_available',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'no_checker_family_available',
        commit: null,
      }
    }

    // Checker dispatch
    const checkerDispatchFn =
      checkerRole.family === 'claude'
        ? (deps.dispatchClaude ?? dispatchClaude)
        : (deps.dispatchCodex ?? dispatchCodex)

    // O Checker roda em outra família: usa o binário dela. Quem não fia `checkerResolved`
    // (provas com dublê) fica com o resolvido do Maker; `null` explícito significa que a
    // fiação tentou resolver e não achou, e aí não há revisão independente possível.
    const checkerResolved =
      deps.checkerResolved === undefined ? deps.resolved : deps.checkerResolved

    if (!checkerDispatchFn || !checkerResolved) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'checker_dispatch_unavailable',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'checker_dispatch_unavailable',
        commit: null,
      }
    }

    // Revisão de insumos que o Checker recebe para declarar o que revisou. A validação compara
    // o que ele devolve com a árvore observada de novo depois da revisão, então um resultado
    // reaproveitado de outra rodada (ou de uma retomada) continua caindo em stale_input_revision.
    const observedDigest = computeObservedInputDigest({
      tree: treeAfterContain,
      changedPaths,
      contractRevision: /** @type {any} */ (story).contract_revision,
    })

    const checkerResultFile = path.join(missionDir, `checker-result-r${round}.json`)
    const checkerStepId = `${storyId}:r${round}:checker`
    const checkerWorkerEnv = {
      ...deps.workerEnv,
      ADE_FAKE_ROLE: 'checker',
      ADE_FAKE_RESULT_FILE: checkerResultFile,
      ADE_INPUT_TREE: treeAfterContain,
      ADE_INPUT_DIGEST: observedDigest,
    }

    const checkerStartedAt = deps.now?.() ?? Date.now()
    /** @type {(dispatch: any, outcome: 'ok' | 'rework' | 'park') => Promise<void>} */
    const appendCheckerTelemetry = (dispatch, outcome) => deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: checkerStepId,
        family: 'codex',
        role: 'checker_round',
        effort: 'default',
        models: modelsFromUsage([], checkerRole.model_id ?? null),
        duration_ms: Math.max(0, (deps.now?.() ?? Date.now()) - checkerStartedAt),
        tokens: dispatch?.tokens ?? { source: 'unavailable' },
        usage: dispatch?.usage,
        pack: packTelemetry(currentManifest),
        skills: currentManifest.skills ?? [],
        sources: (dispatch?.review_result?.sources ?? []).filter((/** @type {unknown} */ x) => typeof x === 'string'),
        outcome,
        ttft_ms: null,
        approval_decisions: 0,
        network_attempts: 0,
        files_touched: 0,
        tool_output_raw_bytes: 0,
        tool_output_model_bytes: 0,
      }),
    })

    let checkerDispatch
    try {
      checkerDispatch = await checkerDispatchFn({
        step: authorizedStep(
          deps.step,
          paidAuthorization,
          deps.now?.() ?? Date.now(),
        ),
        authorization: paidAuthorization,
        unit: storyId,
        stepId: checkerStepId,
        packPath: currentPackPath,
        missionDir,
        missionId,
        cwd: worktreeDir,
        resultFile: checkerResultFile,
        maxBudgetUsd: authorizedReservation.usd,
        model: checkerRole.model_id,
        resolved: checkerResolved,
        env: checkerWorkerEnv,
        role: 'checker_round',
        sandbox: 'read-only',
      })
    } catch (err) {
      const dispatchErrorReason = err instanceof AdeError ? err.code : 'checker_dispatch_failed'
      await appendCheckerTelemetry(undefined, 'park')
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: dispatchErrorReason,
          unit: storyId,
          commit: null,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: dispatchErrorReason,
        commit: null,
      }
    }

    let reviewDoc = checkerDispatch?.review_result
    if (!reviewDoc && fs.existsSync(checkerResultFile)) {
      try {
        reviewDoc = JSON.parse(fs.readFileSync(checkerResultFile, 'utf8'))
      } catch (err) {
        await deps.journal.append({
          kind: 'review_error',
          unit: storyId,
          data: {
            round,
            envelope_error: 'not_json',
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    await appendCheckerTelemetry(checkerDispatch, !reviewDoc ? 'park' : isReviewApproved(reviewDoc).approved ? 'ok' : 'rework')

    if (!reviewDoc) {
      const failReason = checkerDispatch?.envelope_error ?? 'no_review_result'
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: failReason,
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: failReason,
        commit: null,
      }
    }

    const verifiedRefs = new Set()
    for (const ref of executedEvalRefs) {
      verifiedRefs.add(`eval:${ref}`)
    }
    for (const g of gateRes.results ?? []) {
      if (g.id) verifiedRefs.add(`gate:${g.id}`)
    }
    for (const p of changedPaths) {
      verifiedRefs.add(`file:${p}`)
      const fullPath = path.join(worktreeDir, p)
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const lines = fs.readFileSync(fullPath, 'utf8').split('\n').length
          verifiedRefs.add(`file:${p}#L1-L${lines}`)
          verifiedRefs.add(`file:${p}#L1-L1`)
        }
      } catch {
        // Arquivo ilegível agora (corrida/permissão): a ref com intervalo de linhas fica
        // sem verificação e o Checker que a citar será recusado por unverified_reference.
      }
    }
    for (const evalDef of story.evals ?? []) {
      for (const evPath of evalDef.evidence ?? []) {
        verifiedRefs.add(`file:${evPath}`)
        const fullPath = path.join(worktreeDir, evPath)
        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const lines = fs.readFileSync(fullPath, 'utf8').split('\n').length
            verifiedRefs.add(`file:${evPath}#L1-L${lines}`)
            verifiedRefs.add(`file:${evPath}#L1-L1`)
          }
        } catch {
          // Mesmo caso do laço acima: evidência ilegível não vira ref verificada.
        }
      }
    }

    const reviewContext = {
      contractRevision: /** @type {any} */ (story).contract_revision ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      inputRevision: {
        tree: treeAfterContain,
        digest: observedDigest,
      },
      verifiedRefs: Array.from(verifiedRefs),
    }

    const reviewApproval = isReviewApproved(reviewDoc, reviewContext)

    await deps.journal.append({
      kind: 'review_result',
      unit: storyId,
      data: {
        round,
        approved: reviewApproval.approved,
        verdict: reviewDoc?.verdict ?? 'unknown',
        errors: reviewApproval.errors,
        result: reviewDoc,
      },
    })

    if (reviewApproval.approved) {
      maybeEngineFault('before_commit', env)

      const commitStepResult = await deps.step(
        {
          unit: storyId,
          id: `${storyId}:commit`,
          effect_class: 'local_commit',
          input: { tree: treeAfterContain },
        },
        () => wtPort.commit({ message: `ade(${storyId}): ${contract.title}` }),
      )

      maybeEngineFault('after_commit', env)

      const commitSha = /** @type {any} */ (commitStepResult.result)?.commit

      // Noite desatendida (`deliver: false`): o commit revisado é o checkpoint da unidade e a base
      // do operador não anda sozinha durante a noite; o relatório matinal traz o merge de cada
      // unidade comitada.
      if (input.deliver === false) {
        await journal.append({
          kind: 'story_done',
          unit: storyId,
          data: {
            status: 'committed',
            reason: null,
            commit: commitSha,
            spec_revision: story.spec_revision,
            unit: storyId,
            verified_tree: treeAfterContain,
          },
        })
        return { status: 'committed', exitCode: 0, reason: null, commit: commitSha }
      }

      const delivery = await deliverStory({
        journal,
        events: readEvents(),
        gitPort: basePort,
        storyId,
        baseRef,
        baseBefore,
        reviewedCommit: commitSha,
      })
      const deliveryStatus = delivery.delivered ? 'delivered' : 'awaiting_operator'

      await journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: deliveryStatus,
          reason: delivery.delivered ? null : delivery.reason,
          commit: commitSha,
          spec_revision: story.spec_revision,
          unit: storyId,
          verified_tree: treeAfterContain,
        },
      })

      return {
        status: deliveryStatus,
        exitCode: delivery.delivered ? 0 : 3,
        reason: delivery.delivered ? null : delivery.reason,
        commit: commitSha,
      }
    }

    // Not approved
    if (reviewDoc?.verdict !== 'changes_requested') {
      const failReason = reviewApproval.errors[0]?.code ?? 'review_rejected'
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: failReason,
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: failReason,
        commit: null,
      }
    }

    // Verdict é changes_requested
    const findings = (reviewDoc.action_items ?? reviewDoc.findings ?? []).map(normalizeFinding)
    const currentFindingsDigest = computeFindingsDigest(findings)

    // Orçamento de retrabalho esgotado tem precedência: depois da última rodada permitida o
    // diagnóstico é o limite, não a repetição de achados.
    if (round > maxReworkRounds) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'rework_exhausted',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'rework_exhausted',
        commit: null,
      }
    }

    if (previousFindingsDigest !== null && currentFindingsDigest === previousFindingsDigest) {
      await deps.journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: 'awaiting_operator',
          reason: 'stagnation',
          unit: storyId,
          commit: null,
        },
      })
      return {
        status: 'awaiting_operator',
        exitCode: 3,
        reason: 'stagnation',
        commit: null,
      }
    }

    previousFindingsDigest = currentFindingsDigest
    previousFindings = findings
    openFindings = findings.filter(isBlockingFinding)
    treeBeforeRound = treeAfterContain
    round++
  }
}
