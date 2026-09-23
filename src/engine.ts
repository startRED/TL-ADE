// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from './journal/errors.ts'
import { readJournal } from './journal/journal.ts'
import { assertCallBudget, authorizePaidCall, DEFAULT_CONTEXT_LIMIT_BYTES, observedUsd, reserveCalls, validateQuotaReceipt } from './engine/budget.ts'
import { deliverStory, withDeliveryFlag } from './engine/deliver.ts'
import { authorizedStep } from './engine/paid-call.ts'
import { maybeEngineFault } from './engine/faults.ts'
import { findStoryCommitted, findStoryStarted } from './engine/resume.ts'
import { preserveInterruptedTree } from './engine/preserve.ts'
import { classifyCallFailure, pauseForQuota, refreshChains, waitQuotaPause } from './engine/quota.ts'
import { buildLadder, classifyMakerOutcome, correctionRequest, ladderStart, nextAttempt, reserveRung, roundsPerRung, type MakerOutcome } from './engine/ladder.ts'
import { blockedInContract, cliModel } from './models/route.ts'
import { readModelSettings } from './models/settings.ts'
import { storyRisk } from './intent/risk.ts'
import { dedupStorySection } from './pack/dedup.ts'
import { measurePackBytes, telemetrySections } from './pack/pack.ts'
import { buildStoryContext, guardStoryContext } from './context/story.ts'
import { dispatchClaude } from './adapters/claude/index.ts'
import { dispatchCodex } from './adapters/codex/index.ts'
import { dispatchAgyUnit } from './adapters/agy/index.ts'
import { runFrontendQuality } from './visual/evaluate.ts'
import { createDesignToolServer } from './visual/design-server.ts'
export { nextReady, runSequentialMission } from './engine/schedule.ts'

/**
 * Calcula o digest canônico dos insumos observados pelo runtime após contain/execução.
 */
export function computeObservedInputDigest({ tree, changedPaths, contractRevision }: { tree: string; changedPaths?: string[]; contractRevision?: string }): string {
  const normalizedPaths = (changedPaths ?? []).slice().sort()
  const payload = [
    tree,
    contractRevision ?? '',
    ...normalizedPaths,
  ].join(':')
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}
import {
  buildReworkHandoff,
  computeFindingsDigest,
  detectUnresolvedFindings,
  normalizeFinding,
} from './review/handoff.ts'
import { blockingReviewFindings, buildReviewHandoff, testEditViolations, wrongTestClaims, wrongTestVerdict } from './review/contract.ts'
import { isReviewApproved } from './review/validate.ts'
import { buildModelTelemetry, modelsFromUsage } from './telemetry/telemetry.ts'
import { commitLines, formatMeasureTrailers, formatProvenanceTrailers, makerCallOf, storyMeasure } from './telemetry/cost.ts'

/**
 * Famílias de modelos com canário aprovado no Slice 1 e v0.2.
 */
export const CANARY_FAMILIES: readonly string[] = ['claude', 'codex']

/**
 * Composição do pack para a telemetria. Manifesto sem a lista de seções (compilador sem
 * detalhamento) vira uma seção única `pack` com o total medido, para a soma continuar fechando.
 */
function packTelemetry(manifest: any) {
  if (Array.isArray(manifest?.sections)) return { sections: telemetrySections(manifest), bytes: manifest.bytes }
  return { sections: [{ section: 'pack', bytes: manifest.bytes, digest: String(manifest.digest ?? '') }], bytes: manifest.bytes }
}

/**
 * Orquestra o ciclo durável de execução de uma story.
 *
 * @param deps Dependências injetáveis do motor.
 * @param deps.journal Instância do journal aberto.
 * @param deps.step Executor de steps com journaling.
 * @param deps.gitPortFor Fábrica de porta git para o diretório de worktree.
 * @param deps.prepareStory Prepara a worktree e branch.
 * @param deps.createEvalRunner Fábrica de executor de evals.
 * @param deps.createGateRunner Fábrica de executor de gates.
 * @param deps.compilePack Compilador do Context Pack.
 * @param deps.contain Executor de contenção de diff e árvore.
 * @param deps.plantCanary Planta canário fora do worktree.
 * @param deps.checkCanary Verifica se o canário foi violado.
 * @param deps.dispatchClaude Despacha execução do modelo para o Maker.
 * @param [deps.dispatchCodex] Despacha execução do modelo para o Checker.
 * @param [deps.checkerResolved] Binário da família do Checker; `null` quando a fiação não o encontrou.
 * @param [deps.reconcileAll] Reconciliador de intenções abertas.
 * @param deps.resolved Binário resolvido e prefixos.
 * @param deps.workerEnv Variáveis de ambiente para o worker.
 * @param deps.capabilities Estado da sonda de capacidades do doctor.
 * @param [deps.env] Variáveis de ambiente da execução.
 * @param [deps.now] Provedor de timestamp atual em ms.
 * @param deps.quotaPort Porta de recibos oficiais de cota.
 * @param [deps.preflight] Verificador de preflight.
 *
 * @param input Parâmetros de entrada da story e do plano.
 * @param input.loaded Plano e contratos carregados.
 * @param input.story Story a ser executada.
 * @param input.repoDir Diretório raiz do repositório alvo.
 * @param input.missionDir Diretório de trabalho da missão em .ade/missions/<mission_id>.
 */
export async function runStory(deps: { journal: { append: (event: Record<string, unknown>) => Promise<Record<string, unknown>> }; step: (spec: { unit: string; id: string; effect_class: string; input: unknown }, effectFn: () => Promise<unknown>) => Promise<{ step_id: string; status: string; result: unknown; reused: boolean }>; gitPortFor: (dir: string) => import('./git/gitport.ts').GitPort; prepareStory: (opts: { repoDir: string; missionId: string; storyId: string }) => Promise<any>; createEvalRunner: (opts: { step: any; missionDir: string; gitPort: any }) => { runEval: (opts: any) => Promise<any> }; createGateRunner: (opts: { step: any; missionDir: string; gitPort: any; packageJson?: any }) => { runGates: (opts: any) => Promise<any> }; compilePack: (opts: any) => { pack_path: string; manifest_path: string; manifest: any }; contain: (opts: any) => Promise<any>; plantCanary: (opts: { worktreeDir: string; outsideDir: string; unitId: string }) => Promise<any> | any; checkCanary: (canary: any) => Promise<any> | any; dispatchClaude: (opts: any) => Promise<any>; dispatchCodex?: (opts: any) => Promise<any>; checkerResolved?: { exe: string; prefixArgs: string[] } | null; agyResolved?: { exe: string; prefixArgs: string[] } | null; dispatchAgy?: (opts: any) => Promise<any>; reconcileAll?: any; resolved: { exe: string; prefixArgs: string[] }; workerEnv: Record<string, string>; capabilities: { probe_ok: boolean | null }; env?: NodeJS.ProcessEnv; now?: () => number; sleep?: (ms: number) => Promise<unknown>; quotaPort: { readReceipt: ({ family, now }: { family: string; now: number }) => Promise<any> }; preflight?: (opts: { story: any; loaded: any; repoDir: string; events: any[] }) => Promise<{ ready: boolean; checks: any[]; failures: any[]; calls_avoided: number }> }, input: { loaded: import('./engine/plan-load.ts').LoadedPlan; story: import('./engine/plan-load.ts').LoadedStory; repoDir: string; missionDir: string }): Promise<{ status: 'committed' | 'delivered' | 'awaiting_operator'; exitCode: 0 | 3; reason: string | null; commit: string | null; delivered: boolean }> {
  const result = await runStoryImpl({ ...deps, journal: withDeliveryFlag(deps.journal) }, input)
  return { ...result, delivered: result.status === 'delivered' }
}

async function runStoryImpl(deps: any, input: any): Promise<{ status: 'committed' | 'delivered' | 'awaiting_operator'; exitCode: 0 | 3; reason: string | null; commit: string | null }> {
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
  const parkStory = async (reason: string) => {
    await deps.journal.append({ kind: 'story_done', unit: storyId, data: { status: 'awaiting_operator', reason, unit: storyId, commit: null } })
    return { status: 'awaiting_operator' as const, exitCode: 3 as const, reason, commit: null }
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

  // Filas pelos planos do usuário (ADR 0033), refeitas a cada parte e ao retomar de pausa por cota; sem planos valem os
  // papéis do contrato, com o bloqueio do usuário conferido antes de qualquer despacho. O plano aprovado não muda.
  const settings = readModelSettings(repoDir)
  const refresh = () => refreshChains({ journal: deps.journal, quotaPort: deps.quotaPort, settings, repoDir, events: readEvents(), contract, now: deps.now?.() ?? Date.now() })
  const noWriter = () => parkStory(settings.blocked.length > 0
    ? `modelo bloqueado pelo usuário: nenhum modelo sobrou para escrever (${settings.blocked.join(', ')})`
    : 'no_writer_available')
  let routed = await refresh()
  if (routed && routed.chains.fix.length === 0) return await noWriter()
  if (!routed) {
    const blocked = blockedInContract(settings, contract, deps.makerLadder ?? [])
    if (blocked) return await parkStory(`modelo bloqueado pelo usuário: ${blocked.model} (${blocked.role})`)
  }
  const writerFamily = routed ? routed.chains.fix[0].family : makerFamily

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
    const reservationData = (data)
    return event.kind === 'budget_reserved' &&
      (event.unit === storyId || reservationData.unit === storyId) &&
      reservationData.quota_receipt
  })
  const previousReservationData = previousReservation?.data
  const previousQuotaReceipt = previousReservationData &&
    typeof previousReservationData === 'object' &&
    !Array.isArray(previousReservationData)
    ? (previousReservationData).quota_receipt
    : undefined
  let quotaReceipt = previousQuotaReceipt ?? (routed ? routed.receipts[writerFamily as keyof typeof routed.receipts] ?? null : await deps.quotaPort.readReceipt({
    family: makerFamily,
    now: deps.now?.() ?? Date.now(),
  }))
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
    family: writerFamily,
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
        // o dólar é informativo (ADR 0032): fica registrado e não bloqueia
        usd_total: paidCall.usd_total,
        unit: storyId,
      },
    })
  }

  const authorizedReservation = hasPreviousReservation
    ? {
        calls: (previousReservationData).calls,
        usd: (previousReservationData).usd,
        turns: (previousReservationData).turns,
        family: (previousReservationData).family,
      }
    : paidCall.reservation

  
  let worktreeDir: string
  
  let wtPort: import('./git/gitport.ts').GitPort
  
  let treeBefore: string
  const basePort = deps.gitPortFor(repoDir)
  
  let baseRef: string | null = null
  
  let baseBefore: string | null = null

  const started = findStoryStarted(readEvents(), storyId)
  if (started && fs.existsSync(started.worktree_dir)) {
    worktreeDir = started.worktree_dir
    treeBefore = started.tree_before
    baseRef = started.base_ref
    baseBefore = started.base_before
    wtPort = deps.gitPortFor(worktreeDir)
    const kept = await preserveInterruptedTree({
      gitPort: wtPort,
      treeBefore,
      label: `interrupted/${storyId}`,
      scope: contract.guardrails?.scope_paths ?? [],
      blocked: contract.guardrails?.do_not_touch ?? [],
    })
    await deps.journal.append({
      kind: 'story_resumed',
      unit: storyId,
      data: {
        unit: storyId,
        reason: 'story_started_in_journal',
        worktree_dir: worktreeDir,
        tree_before: treeBefore,
        interrupted_ref: kept.ref,
        interrupted_reapplied: kept.reapplied,
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

    const prepResult = (prepareStepResult.result)
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
        // Contrato sem cenários deixa os critérios desconhecidos na medida, nunca 0.
        criteria: Array.isArray(contract.scenarios) ? contract.scenarios.length : null,
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
    sections: { ...baseSections, story: contextStorySection, retrieved: storyContext.sections.retrieved, skills: storyContext.sections?.skills || '' },
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
  let previousFindingsDigest = null
  let previousFindings = []
  let openFindings = []
  // vermelhas cobráveis da última tentativa reprovada por portão ou eval
  let redTests: string[] = []
  // provas que o maker alegou erradas e as que o revisor liberou para edição
  let claimedWrongTests: string[] = []
  let allowedWrongTests: string[] = []
  let treeBeforeRound = treeBefore
  // Escada de quem escreve: a fila `fix` com planos; sem eles, os degraus de quem chama ou só o maker do contrato. Cada
  // degrau vai pelo despachante da sua empresa; com planos, as rodadas por degrau seguem o risco da parte.
  const dispatcherFor = (family: string) => ({ claude: deps.dispatchClaude ?? dispatchClaude, codex: deps.dispatchCodex ?? dispatchCodex, agy: deps.dispatchAgy ?? dispatchAgyUnit } as Record<string, ((opts: any) => Promise<any>) | undefined>)[family]
  // cada empresa usa o binário que a fiação resolveu para ela; `null` explícito = não achou; sem fiação (dublês), o do Claude
  const binaryFor = (family: string) => {
    const own = family === 'codex' ? deps.checkerResolved : family === 'agy' ? deps.agyResolved : deps.resolved
    return own === undefined ? deps.resolved : own
  }
  const startLadder = (route: typeof routed) => {
    const rungs = route
      ? route.chains.fix.map((slot) => ({ model: slot.model, family: slot.family, effort: slot.effort, reserve: slot.reserve }))
      : (deps.makerLadder ?? [{ model: makerModel ?? null, family: makerFamily }])
    const orphan = rungs.find((rung: { family: string }) => !dispatcherFor(rung.family))
    if (orphan) throw new AdeError('invalid_ladder', `degrau da família ${orphan.family} sem despachante`, 4)
    return ladderStart(buildLadder(rungs), route ? roundsPerRung(storyRisk(contract)) : undefined)
  }
  let ladderState = startLadder(routed)
  let attempt = 0
  let treeBeforeAttempt = treeBefore

  // Aplica a decisão da escada; troca de degrau passa pela reserva de chamadas e, negada, estaciona.
  const climbLadder = async (outcome: MakerOutcome, rejectReason = 'rework_exhausted') => {
    const decision = nextAttempt(ladderState, outcome)
    let parkReason: string | null = null
    if (decision.kind === 'park') {
      if (outcome.kind === 'rejected') parkReason = rejectReason
      // retrabalho que não mexeu em nada com achado grave aberto é achado não corrigido
      else if (outcome.kind === 'no_change' && round > 1 && openFindings.length > 0) parkReason = 'unresolved_blocking_findings'
      else parkReason = `maker_${outcome.kind}`
    } else if (decision.state.rung !== ladderState.rung) {
      const rungUnit = `${storyId}:rung${decision.state.rung}`
      const reserved = reserveRung({ events: readEvents(), storyId, rung: decision.state.rung, maxModelCalls: loaded.missionBudget.max_model_calls })
      if (reserved === 'denied') parkReason = 'ladder_reserve_denied'
      if (reserved === 'reserved') {
        await deps.journal.append({
          kind: 'budget_reserved',
          unit: rungUnit,
          data: { unit: rungUnit, calls: 1, usd: authorizedReservation.usd, turns: decision.maxTurns, family: decision.state.ladder[decision.state.rung].family, phase: 'rework' },
        })
      }
    }
    await deps.journal.append({
      kind: 'decision',
      unit: storyId,
      data: {
        decision: 'maker_ladder',
        outcome: outcome.kind,
        next: parkReason ? 'park' : decision.kind,
        rung: decision.state.rung,
        max_turns: decision.maxTurns,
        counts_as_round: decision.countsAsRound,
      },
    })
    if (!parkReason) ladderState = decision.state
    return { decision, parkReason }
  }

  while (true) {
    // Pausa por cota aberta (desta chamada ou de antes do reinício): dorme até a renovação e retoma sem aprovação nova.
    if (await waitQuotaPause({ journal: deps.journal, events: readEvents(), now: () => deps.now?.() ?? Date.now(), sleep: deps.sleep })) {
      // o recibo de antes da pausa pode ter vencido na espera; com planos, as filas são refeitas com a leitura nova
      if (routed) {
        routed = await refresh()
        if (!routed || routed.chains.fix.length === 0) return await noWriter()
        if (routed.changed) ladderState = startLadder(routed)
      }
      const family = ladderState.ladder[ladderState.rung].family
      quotaReceipt = routed ? routed.receipts[family as keyof typeof routed.receipts] ?? null : await deps.quotaPort.readReceipt({ family, now: deps.now?.() ?? Date.now() })
      const quota = validateQuotaReceipt(quotaReceipt, {
        family,
        max_percent: loaded.missionBudget.max_subscription_weekly_percent ?? 50,
        now: deps.now?.() ?? Date.now(),
      })
      if (!quota.ok) return await parkStory(quota.reason ?? 'quota_unavailable')
    }
    // Tentativa repetida pela escada ganha passo próprio dentro da mesma rodada.
    const tag = attempt === 0 ? `r${round}` : `r${round}t${attempt}`
    let currentPackPath = packResult.pack_path
    let currentManifest = packResult.manifest
    if (round > 1) {
      // O pedido de correção leva as vermelhas cobráveis e os achados graves abertos.
      const correction = correctionRequest({ redTests, findings: openFindings })
      const reworkHandoff = buildReworkHandoff({
        storyId,
        contractRevision: (story).contract_revision ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        treeBase: treeBefore,
        openFindings: correction.findings,
        deltas: [{ kind: 'changed', ref: `file:${storyId}` }],
        round,
        notes: `rework round ${round}`,
      })
      const storySection = dedupStorySection({
        ...story,
        handoff: reworkHandoff,
      })
      const reworkPack = deps.compilePack({
        sections: {
          contract: JSON.stringify(contract),
          policy: 'rework',
          // o texto deduplicado não traz o handoff; o pedido de correção vai junto dele
          story: JSON.stringify({ ...JSON.parse(storySection.text), correction: { red_tests: correction.red_tests, handoff: reworkHandoff } }, null, 2),
        },
        missionDir,
        stepId: `${storyId}:${tag}:pack`,
      })
      currentPackPath = reworkPack.pack_path
      currentManifest = reworkPack.manifest
    }

    // Canário fora da worktree
    const canary = await deps.plantCanary({
      worktreeDir,
      outsideDir: path.join(missionDir, `canary-${tag}`),
      unitId: storyId,
    })

    maybeEngineFault('before_spawn', env)

    const resultFile = path.join(missionDir, `maker-result-${tag}.json`)
    const workerEnv = {
      ...deps.workerEnv,
      ...(deps.workerEnv && !deps.workerEnv.ADE_FAKE_RESULT_FILE
        ? { ADE_FAKE_RESULT_FILE: resultFile }
        : {}),
    }

    const makerStartedAt = deps.now?.() ?? Date.now()
    // quem escreve esta rodada: o degrau atual da escada, pela empresa dele
    const rung = ladderState.ladder[ladderState.rung]
    const makerCliModel = rung.model === null ? undefined : cliModel({ ...rung, model: rung.model })
    const makerResolved = binaryFor(rung.family)
    if (!makerResolved) return await parkStory('writer_dispatch_unavailable')
    let filesTouched = 0

    const paidAuthorization: import('./engine/paid-call.ts').PaidCallAuthorization = {
      authorized: true,
      family: rung.family,
      phase: round === 1 ? 'implementation' : 'rework',
      reservation: { ...authorizedReservation, family: rung.family },
      quota_receipt: routed ? routed.receipts[rung.family as keyof typeof routed.receipts] ?? null : quotaReceipt,
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
        mcpConfigPath = path.join(missionDir, `design-tools-${tag}.json`)
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
    
    const appendMakerTelemetry: (dispatch: any, outcome: 'ok' | 'rework' | 'park' | 'stop') => Promise<void> = (dispatch, outcome): Promise<void> => deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: `${storyId}:${tag}:maker`,
        family: rung.family,
        role: 'maker',
        effort: rung.effort ?? 'default',
        models: modelsFromUsage(dispatch?.usage?.models ?? [], makerCliModel ?? makerModel ?? null),
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
        files_touched: filesTouched,
        tool_output_raw_bytes: 0,
        tool_output_model_bytes: 0,
      }),
    })

    const dispatchMaker = dispatcherFor(rung.family)
    if (!dispatchMaker) throw new AdeError('invalid_ladder', `degrau da família ${rung.family} sem despachante`, 4)
    let dispatch: any
    try {
      dispatch = await dispatchMaker({
        // O bloqueio da chamada paga fica no `step()` write-ahead: o efeito `model_call` só chega ao
        // spawn se o teto despachado for exatamente a reserva autorizada.
        step: authorizedStep(
          deps.step,
          paidAuthorization,
          deps.now?.() ?? Date.now(),
        ),
        authorization: paidAuthorization,
        unit: storyId,
        stepId: `${storyId}:${tag}:maker`,
        packPath: currentPackPath,
        missionDir,
        missionId,
        cwd: worktreeDir,
        resultFile,
        maxBudgetUsd: authorizedReservation.usd,
        resolved: makerResolved,
        env: workerEnv,
        mcpConfigPath,
        // sem isto o maker rodava no padrão da CLI e o modelo escolhido não valia nada; o Google leva o esforço no nome
        model: makerCliModel,
        ...(rung.effort && rung.family !== 'agy' ? { effort: rung.effort } : {}),
        ...(rung.family === 'claude' ? {} : { role: 'maker' }),
        maxTurns: ladderState.maxTurns,
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

    // Cota esgotada não gasta rodada nem anda a escada: registra a pausa e tenta a mesma chamada depois da renovação.
    const failure = classifyCallFailure(dispatch)
    if (failure.kind === 'quota') {
      await appendMakerTelemetry(dispatch, 'stop')
      await pauseForQuota({ journal: deps.journal, events: readEvents(), unit: storyId, stepId: `${storyId}:${tag}:maker`, resetAt: failure.resetAt, now: deps.now?.() ?? Date.now() })
      attempt++
      continue
    }

    maybeEngineFault('before_contain', env)

    const tree = await wtPort.worktreeTree()
    const scopePaths = contract.guardrails?.scope_paths ?? []
    const doNotTouch = contract.guardrails?.do_not_touch ?? []
    const sensitivePaths = contract.guardrails?.sensitive_paths ?? []

    const containStepId = tag === 'r1' ? `${storyId}:contain` : `${storyId}:${tag}:contain`
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

    const containResult = (containStepResult.result)
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
    filesTouched = changedPaths.length

    // Na primeira tentativa o diff da contenção é o da própria chamada; depois, compara a árvore da tentativa.
    const makerOutcome = classifyMakerOutcome({
      subtype: dispatch?.subtype,
      changed: tag === 'r1' ? changedPaths.length > 0 : tree !== treeBeforeAttempt,
      resultText: dispatch?.result_text,
    })
    if (makerOutcome.kind !== 'ok') {
      const { decision, parkReason } = await climbLadder(makerOutcome)
      if (parkReason) {
        await appendMakerTelemetry(dispatch, 'park')
        return await parkStory(parkReason)
      }
      await appendMakerTelemetry(dispatch, 'rework')
      treeBeforeAttempt = tree
      if (decision.countsAsRound) {
        round++
        attempt = 0
      } else {
        attempt++
      }
      continue
    }

    // Prova alegada errada só pode ser editada depois do veredito favorável do revisor; antes, reprova a rodada.
    claimedWrongTests = [...new Set([...claimedWrongTests, ...wrongTestClaims(dispatch?.result_text ?? '')])]
    const testViolations = testEditViolations({ changedPaths, claimed: claimedWrongTests, allowedPaths: allowedWrongTests })
    if (testViolations.length > 0) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'wrong_test_edit_rejected', paths: testViolations } })
      const { parkReason } = await climbLadder({ kind: 'rejected' }, 'wrong_test_edit')
      if (parkReason) {
        await appendMakerTelemetry(dispatch, 'park')
        return await parkStory(parkReason)
      }
      await appendMakerTelemetry(dispatch, 'rework')
      openFindings = testViolations.map((p, i) => normalizeFinding({
        id: `wrong-test-edit-${i + 1}`,
        severity: 'critical',
        category: 'patch',
        target_role: 'maker',
        location: p,
        problem: 'prova alegada errada editada sem veredito favorável do revisor',
        evidence_refs: [`file:${p}`],
        required_action: 'desfazer a edição na prova e manter a alegação PROVA ERRADA para o revisor julgar',
      }, i))
      treeBeforeRound = tree
      treeBeforeAttempt = tree
      round++
      attempt = 0
      continue
    }

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
      // tipos, lint e provas travam só com o que é novo desde a largada da parte
      baseTree: treeBefore,
    })

    await deps.journal.append({
      kind: 'gates_done',
      unit: storyId,
      data: {
        results: gateRes.results,
      },
    })

    const redGates = gateRes.results.filter(
      // `buildExtract` classifica o gate verde como `success`; `passed`/`ok` são as formas
      // antigas e continuam aceitas para journal já gravado.
      (r: any) => r.status !== 'success' && r.status !== 'passed' && r.status !== 'ok',
    )
    // portão que nem deu resultado não é defeito da parte: estaciona sem abrir rodada
    if (!gateRes.ok && redGates.length === 0) return await parkStory('gate_failed')
    if (redGates.length > 0) {
      // vermelha cobrável é rodada reprovada: sobe a escada e a correção leva as provas que a parte deve
      const { parkReason } = await climbLadder({ kind: 'rejected' }, 'gate_failed')
      if (parkReason) return await parkStory(parkReason)
      redTests = redGates.flatMap((r: any) => (r.chargeable_reds?.length ? r.chargeable_reds : [r.gate_id]))
      treeBeforeAttempt = treeAfterContain
      round++
      attempt = 0
      continue
    }

    // Eval verde
    const { runEval: runGreenEval } = deps.createEvalRunner({
      step: deps.step,
      missionDir,
      gitPort: wtPort,
    })

    const executedEvalRefs = []
    const redEvals: string[] = []
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
      if (evalRecord.verdict !== 'green') redEvals.push(evalId)
    }
    if (redEvals.length > 0) {
      const { parkReason } = await climbLadder({ kind: 'rejected' }, 'eval_green_failed')
      if (parkReason) return await parkStory(parkReason)
      redTests = redEvals
      treeBeforeAttempt = treeAfterContain
      round++
      attempt = 0
      continue
    }
    // portões e evals verdes: a próxima correção, se houver, não deve prova vermelha
    redTests = []

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
            round: (round),
            missionDir,
            deps,
          }),
      )

      const fqeRes = (fqeStepResult.result)
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
        const visualFindings = (fqeRes.defects || []).map((d: any) => ({
          severity: d.severity,
          message: `${d.criterion}: ${d.fix} (${d.where})`,
          path: d.where,
        }))
        if (round >= 2) {
          await deps.journal.append({ kind: 'story_done', unit: storyId, data: { status: 'awaiting_operator', reason: 'visual_cut_not_met', unit: storyId, commit: null } })
          return { status: 'awaiting_operator', exitCode: 3, reason: 'visual_cut_not_met', commit: null }
        }
        const { parkReason } = await climbLadder({ kind: 'rejected' })
        if (parkReason) return await parkStory(parkReason)
        openFindings = visualFindings
        previousFindings = visualFindings
        treeBeforeAttempt = treeAfterContain
        round++
        attempt = 0
        continue
      }
    }

    // com planos, o revisor é o primeiro da fila de empresa diferente de quem escreveu esta rodada (ADR 0005, emendado)
    const checkerSlot = routed ? routed.chains.checker.find((slot) => slot.family !== rung.family) : undefined
    // sem planos, o revisor fixo do contrato só vale se não for da empresa de quem escreveu a rodada (a reserva pode ser)
    if (routed ? !checkerSlot : !checkerRole || checkerRole.family === rung.family) {
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

    const checker = checkerSlot
      ? { family: checkerSlot.family as string, model: cliModel(checkerSlot), effort: checkerSlot.effort as string | null }
      : { family: checkerRole.family as string, model: checkerRole.model_id as string | undefined, effort: null }
    const checkerDispatchFn = dispatcherFor(checker.family)

    // O Checker roda em outra família: usa o binário dela. Quem não fia `checkerResolved`
    // (provas com dublê) fica com o resolvido do Maker; `null` explícito significa que a
    // fiação tentou resolver e não achou, e aí não há revisão independente possível.
    const checkerResolved = binaryFor(checker.family)

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
      contractRevision: (story).contract_revision,
    })

    // O revisor recebe o mesmo contrato do maker, os achados anteriores e a resposta do maker.
    const reviewRequest = buildReviewHandoff({
      contract: {
        scope_paths: contract.guardrails?.scope_paths ?? [],
        do_not_touch: contract.guardrails?.do_not_touch ?? [],
        out_of_scope: story.out_of_scope ?? [],
        interfaces: story.interfaces ?? [],
        decisions: story.decisions ?? [],
      },
      priorFindings: previousFindings,
      makerResponse: dispatch?.result_text ?? '',
      diff: changedPaths,
    })
    const reviewPack = deps.compilePack({
      sections: {
        contract: JSON.stringify(contract),
        policy: 'review',
        story: JSON.stringify({ ...JSON.parse(dedupStorySection(story).text), review_request: reviewRequest }, null, 2),
      },
      missionDir,
      stepId: `${storyId}:r${round}:review-pack`,
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
    
    const appendCheckerTelemetry: (dispatch: any, outcome: 'ok' | 'rework' | 'park') => Promise<void> = (dispatch, outcome): Promise<void> => deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: checkerStepId,
        family: checker.family,
        role: 'checker_round',
        effort: checker.effort ?? 'default',
        models: modelsFromUsage([], checker.model ?? null),
        duration_ms: Math.max(0, (deps.now?.() ?? Date.now()) - checkerStartedAt),
        tokens: dispatch?.tokens ?? { source: 'unavailable' },
        usage: dispatch?.usage,
        pack: packTelemetry(reviewPack.manifest),
        skills: reviewPack.manifest.skills ?? [],
        sources: (dispatch?.review_result?.sources ?? []).filter((x: unknown) => typeof x === 'string'),
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
        packPath: reviewPack.pack_path,
        missionDir,
        missionId,
        cwd: worktreeDir,
        resultFile: checkerResultFile,
        maxBudgetUsd: authorizedReservation.usd,
        model: checker.model,
        ...(checker.effort && checker.family !== 'agy' ? { effort: checker.effort } : {}),
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
      contractRevision: (story).contract_revision ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
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

      const commitEvents = readEvents()
      const measure = storyMeasure(commitEvents, storyId)
      // a árvore aprovada saiu da última chamada do maker desta parte; o commit aponta para ela
      const makerCall = makerCallOf(commitEvents, storyId)
      if (!makerCall) throw new AdeError('missing_maker_call', `parte ${storyId} aprovada sem chamada do maker no journal`, 4)
      const commitStepResult = await deps.step(
        {
          unit: storyId,
          id: `${storyId}:commit`,
          effect_class: 'local_commit',
          input: { tree: treeAfterContain },
        },
        () => wtPort.commit({ message: `ade(${storyId}): ${contract.title}

${formatMeasureTrailers(measure)}
${formatProvenanceTrailers({ mission: missionId, story: storyId, round, ...makerCall })}` }),
      )

      maybeEngineFault('after_commit', env)

      const commitSha = (commitStepResult.result)?.commit
      // as linhas aprovadas entram na medida gravada, depois dos rodapés do commit (que ficam como eram)
      const approvedMeasure = { ...measure, ...await commitLines(wtPort, baseBefore, commitSha ?? null) }

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
            measure: approvedMeasure,
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
          measure: approvedMeasure,
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

    // Rodada reprovada: duas por degrau, depois sobe; esgotada a escada, estaciona. Só a escada limita as rodadas:
    // achado repetido não estaciona antes dela (o degrau de cima ainda tenta), só dá nome ao fim.
    const stagnated = previousFindingsDigest !== null && currentFindingsDigest === previousFindingsDigest
    const { parkReason } = await climbLadder({ kind: 'rejected' }, stagnated ? 'stagnation' : 'rework_exhausted')
    if (parkReason) return await parkStory(parkReason)

    previousFindingsDigest = currentFindingsDigest
    previousFindings = findings
    allowedWrongTests = [
      ...new Set([...allowedWrongTests, ...wrongTestVerdict({ claimed: reviewRequest.maker_response.wrong_tests, verdicts: reviewDoc.wrong_tests ?? [] }).allowedPaths]),
    ]
    openFindings = blockingReviewFindings({ findings: reviewDoc.action_items ?? reviewDoc.findings ?? [], request: reviewRequest, round })
    treeBeforeRound = treeAfterContain
    treeBeforeAttempt = treeAfterContain
    round++
    attempt = 0
  }
}
