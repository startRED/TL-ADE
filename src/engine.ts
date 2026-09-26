// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AdeError } from './journal/errors.ts'
import { readJournal } from './journal/journal.ts'
import { assertCallBudget, authorizePaidCall, budgetExtension, DEFAULT_CONTEXT_LIMIT_BYTES, observedUsd, reserveCalls, validateQuotaReceipt } from './engine/budget.ts'
import { deliverStory, rebaseOntoMovedBase, withDeliveryFlag } from './engine/deliver.ts'
import { authorizedStep } from './engine/paid-call.ts'
import { maybeEngineFault } from './engine/faults.ts'
import { findStoryCommitted, findStoryStarted } from './engine/resume.ts'
import { preserveInterruptedTree } from './engine/preserve.ts'
import { rewriteJourney, writeProof } from './engine/proof.ts'
import { classifyCallFailure, pauseForQuota, refreshChains, waitQuotaPause } from './engine/quota.ts'
import { buildLadder, classifyMakerOutcome, correctionRequest, ladderStart, nextAttempt, reserveRung, resumableSession, retryRoundBonus, roundsPerRung, type MakerOutcome, type MakerSession } from './engine/ladder.ts'
import { readMissionOptionsBesidePlan } from './mission/options.ts'
import { blockedInContract, cliModel } from './models/route.ts'
import { readModelSettings } from './models/settings.ts'
import { storyRisk } from './intent/risk.ts'
import { dedupStorySection } from './pack/dedup.ts'
import { measurePackBytes, packTelemetry } from './pack/pack.ts'
import { buildStoryContext, guardStoryContext, projectRecipes, recipePolicy, roleSkillsSection } from './context/story.ts'
import { dispatchClaude } from './adapters/claude/index.ts'
import { dispatchCodex } from './adapters/codex/index.ts'
import { dispatchAgyUnit } from './adapters/agy/index.ts'
import { runFrontendQuality } from './visual/evaluate.ts'
import { adoptJourney, journeyFile, runJourneyCheck, validateJourney, type JourneyFailure } from './visual/journey.ts'
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
  isBlockingFinding,
  normalizeFinding,
} from './review/handoff.ts'
import { applyReviewProofs, makeReviewCopy, PROOF_DIR, readReviewProofs, removeReviewCopy } from './review/scratch.ts'
import { safeId } from './gates/output.ts'
import { blockingReviewFindings, buildReviewHandoff, journeyWrongClaim, testEditViolations, wrongTestClaims, wrongTestVerdict } from './review/contract.ts'
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
/** Instrução do revisor de outra empresa: sem ela o modelo real inventava as revisões e citava refs que o motor não verifica. */
const REVIEW_POLICY = [
  'Você revisa esta parte e é de outra empresa, não de quem escreveu. Leia o contrato, o review_request e o código.',
  '- A pasta atual é uma cópia descartável da árvore revisada, com node_modules: rode comandos e escreva arquivos à vontade nela (git diff HEAD mostra o que mudou). Nada do que você mexe volta para o código de quem escreveu.',
  '- Aprove só se o código e as provas cumprem os critérios do contrato; senão, liste os achados com severidade e ação.',
  '- Achado que bloqueia (critical, high ou medium para o maker) precisa de prova executável: rode o comando que mostra o defeito (ou escreva em .ade-review/ um teste que falha e rode-o) e grave .ade-review/<id do achado>.json com {"argv": ["node", ...], "exit_code": <código de saída>, "output": "<trecho da saída que mostra o defeito>"}. argv sem shell: comece por node e nunca use npx nem npm. Cite artifact:.ade-review/<id do achado>.json no evidence_refs do achado e como result_ref de um item de evidence. Achado sem essa prova é rebaixado a low pelo motor e não bloqueia.',
  '- Copie contract_revision e input_revision exatamente como estão em echo_exactly.',
  '- Em evidence, sources, evidence_refs e result_ref, cite só referências da lista citable_refs, escritas igual (arquivo sempre com intervalo de linhas), ou as artifact:.ade-review/ que você gravou.',
  '- Toda ref que um achado (action_items, deferred, rejected) ou uma claim do handoff cita em evidence_refs precisa aparecer também como result_ref de um item de evidence; e cada critério do contrato precisa de um item de evidence.',
  '- As provas já rodaram no motor: proof_results é o resultado oficial (verde julgado contra a largada conta como verde, e as vermelhas listadas nos avisos já existiam antes da parte). Não rode a suíte inteira nem reprove por não conseguir rodá-la; rode só o que prova o seu achado.',
  '- A TL-ADE é autônoma e não há operador para decidir nada durante a missão. Se um requisito do contrato é impossível dentro do escopo (decisão de produto ou de intenção, não defeito do código), não reprove por ele: aprove o que foi entregue e registre o requisito em deferred, com o motivo. Reprove só por defeito que quem escreve consegue corrigir dentro do escopo.',
  '- Responda somente pelo schema.',
].join('\n')

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
  // config do projeto (.ade/config.json): o run.ts só a lia para o digest e o FQE recebia {} e nunca servia a tela (25/09)
  const projectConfig = loaded.config ?? readProjectConfig(repoDir)
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
  const ranBefore = (stepId: string) => readEvents().some((e) => e.kind === 'step_result' && e.step_id === stepId && e.status === 'ok')
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
  // Extensão aprovada pelo operador para esta parte ("mais N chamadas a partir de agora") vale só para ela.
  const effectiveMaxCalls = Math.max(Math.min(
    loaded.plan.budget.max_model_calls,
    contract.budget.max_model_calls,
    loaded.lineageCallsRemaining ?? Infinity,
  ), budgetExtension(eventsBeforeReservation, storyId))
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
    // Provas já escritas antes da queda ficaram na árvore (a interrompida pertence à parte): a parte recomeça da
    // árvore das provas, como no caminho sem queda; a de antes delas só teria o vermelho que nasceu verde.
    const proofTree = [...readEvents()].reverse().find((e) =>
      e.kind === 'decision' && e.data?.decision === 'proof_written' && (e.unit ?? e.data?.unit) === storyId)?.data?.tree
    if (kept.reapplied && typeof proofTree === 'string') treeBefore = proofTree
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
  // Receita do projeto para subir e usar o programa: a política pede a conferência rodando o app e o texto vai no pack de
  // toda empresa, porque Codex e agy não leem .claude/skills (ADR 0048)
  const recipes = projectRecipes(worktreeDir)
  const recipeAsk = recipePolicy(recipes)
  const recipeText = recipes.length === 0 ? '' : `\n\napp_recipes:\n${recipes.map((r) => `### ${r.path}\n\n${r.text}`).join('\n\n')}`
  const packResult = deps.compilePack({
    missionDir,
    stepId: `${storyId}:r1:maker`,
    sections: { ...baseSections, policy: baseSections.policy + recipeAsk, story: contextStorySection + recipeText, retrieved: storyContext.sections.retrieved, skills: storyContext.sections?.skills || '' },
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

  const proofWritersFor = async () => {
    const now = deps.now?.() ?? Date.now()
    const cap = loaded.missionBudget.max_subscription_weekly_percent ?? 50
    const slots: Array<{ family: string; model?: string; effort?: string | null }> = routed
      ? [...routed.chains.checker, ...routed.chains.fix].map((slot) => ({ family: slot.family, model: cliModel(slot), effort: slot.effort ?? null }))
      : [
          ...(checkerRole ? [{ family: checkerRole.family as string, model: checkerRole.model_id as string | undefined }] : []),
          { family: makerFamily as string, model: makerModel as string | undefined },
        ]
    const ordered = [...slots.filter((slot) => slot.family !== writerFamily), ...slots.filter((slot) => slot.family === writerFamily)]
    const writers: Array<any> = []
    for (const slot of ordered) {
      const dispatch = dispatcherFor(slot.family)
      const resolved = binaryFor(slot.family)
      if (!dispatch || !resolved) continue
      const receipt = routed ? routed.receipts[slot.family as keyof typeof routed.receipts] ?? null : await deps.quotaPort.readReceipt({ family: slot.family, now })
      if (!validateQuotaReceipt(receipt, { family: slot.family, max_percent: cap, now }).ok) continue
      writers.push({ ...slot, dispatch, resolved, receipt })
    }
    return writers
  }

  // Juízes visuais: o melhor modelo de cada empresa com cota e binário, na ordem da fila de revisão. Julgar a imagem não é
  // revisar o próprio código, então quem escreveu a tela também julga; o FQE cruza as opiniões (25/09).
  const visualJudges = async () => {
    const now = deps.now?.() ?? Date.now()
    const cap = loaded.missionBudget.max_subscription_weekly_percent ?? 50
    const slots: Array<{ family: string; model_id: string; effort?: string | null }> = routed
      ? [...routed.chains.checker, ...routed.chains.fix].map((slot) => ({ family: slot.family, model_id: cliModel(slot), effort: slot.effort ?? null }))
      : [
          ...(checkerRole ? [{ family: checkerRole.family as string, model_id: checkerRole.model_id as string }] : []),
          { family: makerFamily as string, model_id: makerModel as string },
        ]
    const judges: Array<{ family: string; model_id: string; effort?: string | null; resolved: { exe: string; prefixArgs: string[] } }> = []
    for (const slot of slots) {
      if (judges.some((j) => j.family === slot.family)) continue
      const resolved = binaryFor(slot.family)
      if (!resolved) continue
      const receipt = routed ? routed.receipts[slot.family as keyof typeof routed.receipts] ?? null : await deps.quotaPort.readReceipt({ family: slot.family, now })
      if (!validateQuotaReceipt(receipt, { family: slot.family, max_percent: cap, now }).ok) continue
      judges.push({ ...slot, resolved })
    }
    return judges
  }

  // Roteiro de navegador que a prova escreveu (parte com tela): vira a cópia oficial fora da worktree e roda uma vez na
  // árvore da prova, antes do código. Roteiro que já passa não prova a mudança nova, mas fica contra regressão.
  // Sem roteiro, roteiro inválido ou sem serve, a parte segue e o motivo fica no journal.
  const adoptJourneyScript = async () => {
    const adopted = adoptJourney(worktreeDir, missionDir, storyId)
    if (!adopted || 'errors' in adopted) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'journey_skipped', unit: storyId, reason: adopted ? 'invalid_script' : 'no_script', errors: adopted?.errors ?? [] } })
      return
    }
    const check: any = (await deps.step(
      { unit: storyId, id: `${storyId}:journey:red`, effect_class: 'none', input: { tree: treeBefore } },
      () => (deps.runJourneyCheck ?? runJourneyCheck)({ file: adopted.file, config: projectConfig, cwd: worktreeDir, outDir: path.join(missionDir, 'artifacts', 'visual', treeBefore) }),
    )).result
    const decision = check.status === 'pass' ? 'journey_not_red' : check.status === 'fail' ? 'journey_red' : 'journey_red_unchecked'
    await deps.journal.append({
      kind: 'decision',
      unit: storyId,
      data: { decision, unit: storyId, file: adopted.file, counts_as_proof: check.status === 'fail', reason: check.reason ?? null, needs_data: check.needs_data ?? [] },
    })
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

  // Despachante e binário de cada empresa (quem escreve provas, quem escreve código e quem revisa).
  const dispatcherFor = (family: string) => ({ claude: deps.dispatchClaude ?? dispatchClaude, codex: deps.dispatchCodex ?? dispatchCodex, agy: deps.dispatchAgy ?? dispatchAgyUnit } as Record<string, ((opts: any) => Promise<any>) | undefined>)[family]
  // cada empresa usa o binário que a fiação resolveu para ela; `null` explícito = não achou; sem fiação (dublês), o do Claude
  const binaryFor = (family: string) => {
    const own = family === 'codex' ? deps.checkerResolved : family === 'agy' ? deps.agyResolved : deps.resolved
    return own === undefined ? deps.resolved : own
  }

  // Eval vermelho. Sem prova que falhe antes do código (pedido do painel traz critérios, não testes), a etapa de prova
  // escreve os testes dos critérios e o vermelho roda de novo sobre eles (ADR 0036). Retomada já tem as provas na árvore.
  const redIsValid = async (tree: string) => {
    // prova genérica (a suíte inteira) depois da etapa de provas roda só os testes escritos: a suíte toda do painel passou
    // dos 600 s sob carga, virou "environment" e estacionou a parte (missão real de anexos, 25/09)
    const proofFiles: string[] = wholeSuite
      ? ([...readEvents()].reverse().find((e) => e.kind === 'decision' && e.data?.decision === 'proof_written' && (e.unit ?? e.data?.unit) === storyId)?.data?.files ?? [])
      : []
    for (const def of story.evals) {
      const evalDef = proofFiles.length > 0 ? { ...def, id: `${def.id}-prova`, argv: [...def.argv, ...proofFiles] } : def
      const evalRecord = await runRedEval({ eval: evalDef, phase: 'red', tree, unit: storyId })
      if (evalRecord.verdict !== 'red' && evalRecord.verdict !== 'red_valid') return false
    }
    return true
  }
  // Prova que é a suíte inteira do projeto (o script test, como o compilador monta a V1) já falha na base por vermelhas
  // antigas: esse vermelho não prova nada da parte, e a etapa de provas roda do mesmo jeito (S2 da missão real).
  const projectTest = (() => {
    try {
      const script = JSON.parse(fs.readFileSync(path.join(worktreeDir, 'package.json'), 'utf8'))?.scripts?.test
      return typeof script === 'string' ? script.trim().split(/\s+/) : null
    } catch {
      return null
    }
  })()
  const sameArgv = (a: string[], b: string[] | null) => !!b && a.length === b.length && a.every((x, i) => x === b[i])
  // Genérica = roda a suíte inteira e não cita arquivo de teste como evidência (o compilador cita só o package.json);
  // prova específica cita o teste dela e o vermelho da base vale.
  const wholeSuite = story.evals.length > 0 && story.evals.every((e: any) =>
    (sameArgv(e.argv ?? [], projectTest) || sameArgv(e.argv ?? [], ['node', 'node_modules/vitest/vitest.mjs', 'run']))
    && (e.evidence ?? []).every((ev: string) => ev === 'package.json'))
  // "ainda sem provas escritas", não "parte não começou": retomada antes da etapa de provas também precisa dela (S3)
  const proofDone = readEvents().some((e) => e.kind === 'decision' && e.data?.decision === 'proof_written' && (e.unit ?? e.data?.unit) === storyId)
  // suíte inteira antes das provas não prova nada: nem roda (eram minutos descartados a cada parte)
  let redValid = !(wholeSuite && !proofDone) && (await redIsValid(treeBefore))
  if (!redValid && !proofDone) {
    // cada nova tentativa da parte e cada modelo da cadeia têm passo próprio; modelo que cai com erro passa a vez
    const retries = readEvents().filter((e) => e.kind === 'decision' && e.data?.decision === 'unit_retry' && (e.unit ?? e.data?.unit) === storyId).length
    const writers = await proofWritersFor()
    for (const [index, writer] of writers.entries()) {
      const attempt = [retries > 0 ? `a${retries}` : '', index > 0 ? `w${index}` : ''].filter(Boolean).join(':')
      const proof = await writeProof({
        storyId,
        missionId,
        missionDir,
        worktreeDir,
        wtPort,
        treeBefore,
        contract,
        testCommand: story.evals[0]?.argv ?? [],
        writer,
        step: deps.step,
        journal: deps.journal,
        events: readEvents,
        compilePack: deps.compilePack,
        maxModelCalls: effectiveMaxCalls,
        usd: authorizedReservation.usd,
        quotaReceipt: writer.receipt,
        contextBytes,
        weeklyCap: loaded.missionBudget.max_subscription_weekly_percent ?? 50,
        workerEnv: deps.workerEnv,
        ...(attempt ? { attempt } : {}),
        skills: roleSkillsSection('proof', contract?.skills, deps.eligibleSkills),
        now: () => deps.now?.() ?? Date.now(),
      })
      if (proof.kind === 'park' && proof.reason === 'proof_writer_error' && index < writers.length - 1) continue
      if (proof.kind === 'park') return await parkStory(proof.reason)
      if (proof.kind === 'written') {
        treeBefore = proof.tree
        redValid = await redIsValid(treeBefore)
        if (contract.needs_ui) await adoptJourneyScript()
      }
      break
    }
  }
  if (!redValid) {
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

  await deps.journal.append({
    kind: 'pack_manifest',
    unit: storyId,
    data: packResult.manifest,
  })

  let round = 1
  // Passadas visuais flexíveis: até visual.max_rounds (padrão 6) avaliações, cada uma com o maker corrigindo o que os
  // juízes pediram. Não passam pela escada: polir a tela não é falha, não troca de modelo nem gasta rodadas de correção.
  let visualEvals = 0
  const maxVisualEvals = Math.max(1, Number(projectConfig?.visual?.max_rounds) || 6)
  // a avaliação anterior vai aos juízes (sem ela eles se contradiziam entre passadas) e mede o ganho da passada
  let lastVisualEval: any = null
  let visualStalls = 0
  // Jornada: o mesmo passo quebrando do mesmo jeito em duas passadas seguidas pode ser roteiro errado. O maker pode
  // responder ROTEIRO ERRADO e a prova reescreve o roteiro uma única vez na parte.
  let lastJourneyKey: string | null = null
  let lastJourneyFailure: JourneyFailure | null = null
  let journeySuspect = false
  let journeyClaim: string | null = null
  const journeyHasNoSteps = () => {
    try {
      const v = validateJourney(JSON.parse(fs.readFileSync(journeyFile(missionDir, storyId), 'utf8')))
      return v.ok && v.journeys.every((j) => j.needs_data === true)
    } catch {
      return false
    }
  }
  const journeyRewriteUsed = () => readEvents().some((e) => e.kind === 'decision' && ['journey_rewritten', 'journey_rewrite_failed'].includes(e.data?.decision) && (e.unit ?? e.data?.unit) === storyId)
  let previousFindingsDigest = null
  let previousFindings = []
  let openFindings: any[] = []
  // vermelhas cobráveis da última tentativa reprovada por portão ou eval
  let redTests: string[] = []
  // provas que o maker alegou erradas e as que o revisor liberou para edição
  let claimedWrongTests: string[] = []
  let allowedWrongTests: string[] = []
  let treeBeforeRound = treeBefore
  // Escada de quem escreve: a fila `fix` com planos; sem eles, os degraus de quem chama ou só o maker do contrato. Cada
  // degrau vai pelo despachante da sua empresa; com planos, as rodadas por degrau seguem o risco da parte.
  // Tetos fixados na aprovação do painel, ao lado do plano; usd_informative não entra em decisão nenhuma.
  const ceilings = loaded.planDir ? readMissionOptionsBesidePlan(path.join(loaded.planDir, 'plan.json'))?.ceilings : undefined
  const caps = { maxTurns: ceilings?.max_turns ?? undefined, maxRounds: ceilings?.max_rounds ?? undefined }
  const startLadder = (route: typeof routed) => {
    const rungs = route
      ? route.chains.fix.map((slot) => ({ model: slot.model, family: slot.family, effort: slot.effort, reserve: slot.reserve }))
      : (deps.makerLadder ?? [{ model: makerModel ?? null, family: makerFamily }])
    const orphan = rungs.find((rung: { family: string }) => !dispatcherFor(rung.family))
    if (orphan) throw new AdeError('invalid_ladder', `degrau da família ${orphan.family} sem despachante`, 4)
    const perRung = (route ? roundsPerRung(storyRisk(contract)) : roundsPerRung('normal')) * (1 + retryRoundBonus(readEvents(), storyId))
    return ladderStart(buildLadder(rungs), perRung, caps)
  }
  let ladderState = startLadder(routed)
  // sessão da última chamada do maker que a seguinte pode retomar (ADR 0046)
  let makerSession: MakerSession | null = null
  let attempt = 0
  let treeBeforeAttempt = treeBefore

  // Retomada de parte que já teve revisão reprovada (queda, pausa, checagem prévia, nova tentativa): refazer as rodadas
  // antigas pelo cache não fecha, porque a worktree já está no estado final (a revisão antiga fica obsoleta e o modelo
  // antigo "não muda nada"). A parte começa uma rodada nova sobre a árvore atual, com os achados da última revisão
  // (S2 da missão real, 24/09). Parte aprovada ou já commitada segue o caminho de sempre até a entrega.
  {
    const events = readEvents()
    const unitOf = (e: any) => e.unit ?? e.data?.unit
    const committed = events.some((e) => e.kind === 'step_result' && e.step_id === `${storyId}:commit` && e.status === 'ok')
    // a revisão da maior rodada (a mais recente em empate): uma retomada antiga pode ter regravado revisões da rodada 1
    const lastReview = events.filter((e) => e.kind === 'review_result' && unitOf(e) === storyId && e.data?.result)
      .reduce<any>((best, e) => (!best || Number(e.data?.round ?? 0) >= Number(best.data?.round ?? 0) ? e : best), null)
    if (started && lastReview && !lastReview.data?.approved && !committed) {
      const prefix = `${storyId}:r`
      const rounds = events.map((e) => String(e.step_id ?? '')).filter((id) => id.startsWith(prefix)).map((id) => Number.parseInt(id.slice(prefix.length), 10)).filter(Number.isFinite)
      round = Math.max(1, ...rounds) + 1
      const doc = lastReview.data.result
      previousFindings = (doc.action_items ?? doc.findings ?? []).map(normalizeFinding)
      previousFindingsDigest = computeFindingsDigest(previousFindings)
      openFindings = blockingReviewFindings({ findings: doc.action_items ?? doc.findings ?? [], request: { prior_findings: [] } as any, round: 1 })
      treeBeforeAttempt = await wtPort.worktreeTree()
      // os achados valem contra a árvore que a revisão viu, não contra trabalho feito depois dela e nunca revisado
      treeBeforeRound = doc.input_revision?.tree ?? treeBeforeAttempt
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'retry_new_round', unit: storyId, round, open_findings: openFindings.length } })
    } else if (started && lastReview?.data?.approved && !committed && Number(lastReview.data.round) > 1) {
      // aprovada e não entregue (o commit caiu): refazer desde a rodada 1 pelo cache esbarrava na revisão da rodada 1,
      // obsoleta diante da árvore final, e a parte estacionava (missão real de anexos, 25/09). Retoma na rodada aprovada:
      // maker e revisor vêm do cache e só a entrega roda de novo.
      round = Number(lastReview.data.round)
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'resume_approved_round', unit: storyId, round } })
    } else if (started && !lastReview && !committed) {
      // sem revisão ainda (polimento visual): recomeçar na rodada 1 trazia a rodada 2 antiga do cache "sem mudança", a
      // escada subia o maker e o teto de passadas visuais zerava (S3 da missão de anexos, 26/09). Retoma na última
      // rodada do maker, que vem do cache, com as passadas visuais já feitas contadas.
      const makerRound = /^.+:r(\d+):maker$/
      const done = events.filter((e) => e.kind === 'step_result' && e.status === 'ok' && String(e.step_id ?? '').startsWith(`${storyId}:r`))
        .map((e) => makerRound.exec(String(e.step_id))?.[1]).filter(Boolean).map(Number)
      const lastRound = Math.max(1, ...done)
      if (lastRound > 1) {
        round = lastRound
        const passes = events.filter((e) => e.kind === 'visual_eval_done' && unitOf(e) === storyId)
        visualEvals = passes.length
        lastVisualEval = passes.at(-1)?.data?.evaluation ?? null
        // passadas sem ganho também continuam contadas (mesma regra do laço: subir menos de 0,3 é passada parada)
        const finals = passes.map((e) => e.data?.evaluation?.final).filter((f): f is number => typeof f === 'number')
        for (let i = 1; i < finals.length; i++) visualStalls = finals[i] < finals[i - 1] + 0.3 ? visualStalls + 1 : 0
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'resume_round', unit: storyId, round, visual_evals: visualEvals, visual_stalls: visualStalls } })
      }
    }
  }

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
        // filas refeitas não zeram as rodadas já gastas pela parte
        if (routed.changed) ladderState = { ...startLadder(routed), spent: ladderState.spent }
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
    // Chamada seguinte no mesmo degrau retoma a sessão do maker: o mesmo arquivo de pack (prompt de sistema igual, cache
    // da conversa inteira vale) e só o que mudou no prompt, em vez de reler tudo numa sessão nova (ADR 0046).
    const resumeFrom = resumableSession(makerSession, ladderState)
    let currentPackPath: string = resumeFrom?.packPath ?? packResult.pack_path
    let currentManifest: any = resumeFrom?.manifest ?? packResult.manifest
    let resumePrompt: string | undefined
    if (resumeFrom && resumeFrom.round === round) {
      resumePrompt = 'Você foi cortado no teto de turnos antes de terminar. Continue de onde parou e responda somente pelo schema.'
    } else if (round > 1) {
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
      if (resumeFrom) {
        resumePrompt = [
          `Rodada ${round}: o motor reprovou a entrega anterior. Corrija o que está em correction (provas vermelhas e achados abertos) e responda somente pelo schema.`,
          JSON.stringify({ round, correction: { red_tests: correction.red_tests, handoff: reworkHandoff } }, null, 2),
        ].join('\n\n')
      } else {
        const storySection = dedupStorySection({
          ...story,
          handoff: reworkHandoff,
        })
        const reworkPack = deps.compilePack({
          sections: {
            contract: JSON.stringify(contract),
            policy: `rework${recipeAsk}`,
            // o texto deduplicado não traz o handoff; o pedido de correção vai junto dele
            story: JSON.stringify({ ...JSON.parse(storySection.text), correction: { red_tests: correction.red_tests, handoff: reworkHandoff }, ...(recipes.length ? { app_recipes: recipes } : {}) }, null, 2),
          },
          missionDir,
          stepId: `${storyId}:${tag}:pack`,
        })
        currentPackPath = reworkPack.pack_path
        currentManifest = reworkPack.manifest
      }
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
        // sem as ferramentas de design o maker ainda escreve a tela; parar esperando o operador não ajuda ninguém
        designServer = null
        mcpConfigPath = undefined
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'design_tools_unavailable', unit: storyId, error: err instanceof Error ? err.message : String(err) } })
      }
    }

    let makerDurationMs = 0
    
    // Retomada reaproveita a chamada do modelo já feita: a telemetria dela já está no journal e gravá-la de novo dobrava o
    // gasto da parte no painel (e com duração de milissegundos).
    const makerStepId = `${storyId}:${tag}:maker`
    const appendMakerTelemetry: (dispatch: any, outcome: 'ok' | 'rework' | 'park' | 'stop') => Promise<void> = async (dispatch, outcome): Promise<void> => {
      if (readEvents().some((e) => e.kind === 'telemetry' && e.data?.step_id === makerStepId)) return
      await deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: makerStepId,
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
    }

    // modelo e esforço na hora em que a chamada começa: a telemetria só chega no fim e o painel ficava sem mostrar
    // com que esforço cada modelo estava trabalhando (pedido do operador, 25/09)
    // passo que vem do cache (retomada) não é chamada nova: sem o guarda o painel mostrava o esforço de hoje num passo de ontem
    if (!ranBefore(makerStepId)) await deps.journal.append({ kind: 'model_started', unit: storyId, data: { unit: storyId, role: 'maker', step_id: makerStepId, family: rung.family, model_id: rung.model ?? makerModel ?? null, effort: rung.effort ?? null } })
    const dispatchMaker = dispatcherFor(rung.family)
    if (!dispatchMaker) throw new AdeError('invalid_ladder', `degrau da família ${rung.family} sem despachante`, 4)
    // o prompt da retomada fica na pasta da missão ao lado do resultado, como o pack de uma sessão nova
    const resumePromptPath = path.join(missionDir, `maker-resume-${tag}.md`)
    if (resumeFrom && !ranBefore(makerStepId)) {
      fs.writeFileSync(resumePromptPath, resumePrompt ?? '', 'utf8')
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'maker_resume', unit: storyId, step_id: makerStepId, session_ref: resumeFrom.ref, resumes: resumeFrom.resumes + 1, prompt_path: resumePromptPath } })
    }
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
        ...(resumeFrom ? { resumeSessionId: resumeFrom.ref, prompt: resumePrompt } : {}),
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

    // Sessão que não existe mais (outra máquina, arquivo apagado): a mesma rodada é refeita numa sessão nova.
    if (resumeFrom && dispatch?.session_missing) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'maker_resume_fallback', unit: storyId, step_id: makerStepId, session_ref: resumeFrom.ref, next: 'new_session' } })
      makerSession = null
      attempt++
      continue
    }

    // Chamada interrompida (processo morto) volta do journal `ambiguous` e sem resultado: foi cobrada, mas o trabalho dela
    // não chegou. Seguir com a árvore sem mudança estacionava a parte; ela é refeita como nova tentativa.
    if (dispatch?.status === 'ambiguous' && dispatch.exit_code == null && !dispatch.unit_result) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'maker_call_lost', unit: storyId, step_id: `${storyId}:${tag}:maker`, next: 'retry' } })
      if (attempt >= 3) return await parkStory('maker_call_lost')
      makerSession = null
      attempt++
      continue
    }

    // Cota esgotada não gasta rodada nem anda a escada: registra a pausa e tenta a mesma chamada depois da renovação.
    const failure = classifyCallFailure(dispatch)
    if (failure.kind === 'quota') {
      await appendMakerTelemetry(dispatch, 'stop')
      await pauseForQuota({ journal: deps.journal, events: readEvents(), unit: storyId, stepId: `${storyId}:${tag}:maker`, resetAt: failure.resetAt, now: deps.now?.() ?? Date.now() })
      makerSession = null
      attempt++
      continue
    }

    makerSession = typeof dispatch?.session_ref !== 'string' ? null
      : resumeFrom ? { ...resumeFrom, round, resumes: resumeFrom.resumes + 1 }
        : { ref: dispatch.session_ref, packPath: currentPackPath, manifest: currentManifest, rung: ladderState.rung, family: rung.family, model: rung.model, round, resumes: 0 }

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
    // Árvore que nenhuma revisão viu ainda (trabalho de rodada interrompida antes da revisão) conta como mudança: sem isso
    // o modelo que não tinha mais nada a fazer estacionava a parte sem a árvore nunca ser revisada (S2 da missão real).
    const lastReviewedTree = readEvents().filter((e) => e.kind === 'review_result' && (e.unit ?? e.data?.unit) === storyId)
      .map((e) => e.data?.result?.input_revision?.tree).filter(Boolean).at(-1)
    const unreviewed = round > 1 && typeof lastReviewedTree === 'string' && tree !== lastReviewedTree && changedPaths.length > 0
    const makerOutcome = classifyMakerOutcome({
      subtype: dispatch?.subtype,
      changed: tag === 'r1' ? changedPaths.length > 0 : tree !== treeBeforeAttempt || unreviewed,
      resultText: dispatch?.result_text,
    })
    if (makerOutcome.kind !== 'ok') {
      const { decision, parkReason } = await climbLadder(makerOutcome)
      if (parkReason) {
        await appendMakerTelemetry(dispatch, 'park')
        return await parkStory(parkReason)
      }
      await appendMakerTelemetry(dispatch, 'rework')
      // Corte por turnos deixa trabalho pela metade que a continuação termina: ela compara com a árvore de antes do corte,
      // senão terminar sem precisar mudar mais nada virava maker_no_change (S2 da missão real).
      if (makerOutcome.kind !== 'max_turns') treeBeforeAttempt = tree
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
    journeyClaim = journeyWrongClaim(dispatch?.result_text ?? '')
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
    const proofResults: Array<{ eval_id: string; verdict: string; warnings: string[] }> = []
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
        // árvore de largada da parte (antes das provas): vermelha que já existia ali não impede o verde
        baseTree: findStoryStarted(readEvents(), storyId)?.tree_before,
      })
      proofResults.push({ eval_id: evalId, verdict: evalRecord.verdict, warnings: evalRecord.warnings ?? [] })
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
    if (contract.needs_ui && visualEvals < maxVisualEvals) {
      // a prova reescreve o roteiro uma vez: o maker disse que ele contradiz o critério depois do aviso de roteiro
      // suspeito, ou o roteiro não tem passo nenhum (todos needs_data) e a jornada não conferiria nada
      const noSteps = journeyHasNoSteps()
      if (((journeyClaim && journeySuspect && lastJourneyFailure) || noSteps) && !journeyRewriteUsed()) {
        const writer = (await proofWritersFor())[0]
        const rewritten = writer
          ? await rewriteJourney({
              storyId, missionId, missionDir, worktreeDir, wtPort, contract, writer,
              treeBefore: treeAfterContain,
              step: deps.step,
              journal: deps.journal,
              events: readEvents,
              compilePack: deps.compilePack,
              maxModelCalls: effectiveMaxCalls,
              usd: authorizedReservation.usd,
              quotaReceipt: writer.receipt,
              contextBytes,
              weeklyCap: loaded.missionBudget.max_subscription_weekly_percent ?? 50,
              workerEnv: deps.workerEnv,
              skills: roleSkillsSection('proof', contract?.skills, deps.eligibleSkills),
              now: () => deps.now?.() ?? Date.now(),
              failure: noSteps ? null : lastJourneyFailure,
              claim: noSteps ? null : journeyClaim,
              why: noSteps ? 'sem_passos' : 'contradiz_criterio',
            })
          : { kind: 'park' as const, reason: 'no_proof_writer' }
        const adopted = rewritten.kind === 'written' ? adoptJourney(worktreeDir, missionDir, storyId) : null
        const ok = !!adopted && 'file' in adopted
        await deps.journal.append({
          kind: 'decision',
          unit: storyId,
          data: { decision: ok ? 'journey_rewritten' : 'journey_rewrite_failed', unit: storyId, round, reason_to_rewrite: noSteps ? 'sem_passos' : 'contradiz_criterio', claim: noSteps ? null : journeyClaim, reason: rewritten.kind === 'park' ? rewritten.reason : ok ? null : 'invalid_script' },
        })
        lastJourneyKey = null
        journeySuspect = false
      }
      const judges = await visualJudges()
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
              previous_visual_eval: lastVisualEval,
            },
            tree: treeAfterContain,
            config: projectConfig,
            capabilities: deps.capabilities ?? {},
            round: (round),
            missionDir,
            deps: { ...deps, visualJudges: judges },
          }),
      )

      const fqeRes = (fqeStepResult.result)
      // toda passada conta no teto, inclusive a que só reprova nos portões automáticos: sem isso não havia limite
      visualEvals++
      await deps.journal.append({
        kind: 'visual_eval_done',
        unit: storyId,
        data: {
          round,
          status: fqeRes.status,
          reason: fqeRes.reason,
          evaluation: fqeRes.evaluation,
          defects: fqeRes.defects,
          journey: fqeRes.journey?.status ?? null,
        },
      })

      // Jornada de usuário: pulada fica no journal com o motivo; quebrada vira achado com o passo e a evidência
      const journey = fqeRes.journey
      if (journey?.status === 'skipped' || journey?.needs_data?.length) {
        await deps.journal.append({
          kind: 'decision',
          unit: storyId,
          data: { decision: 'journey_skipped', unit: storyId, round, reason: journey.status === 'skipped' ? journey.reason : 'needs_data', errors: journey.errors ?? [], needs_data: journey.needs_data ?? [] },
        })
      }
      // os prints ficam na pasta da missão, fora do alcance do maker; a cópia em .ade/ da worktree (fora do commit)
      // é o que ele consegue abrir
      const evidenceDir = path.join(worktreeDir, '.ade', 'evidence', `r${round}`)
      const toWorktree = (files: string[]) => files.filter((p) => p && fs.existsSync(p)).map((p) => {
        fs.mkdirSync(evidenceDir, { recursive: true })
        const dest = path.join(evidenceDir, path.basename(p))
        fs.copyFileSync(p, dest)
        return path.relative(worktreeDir, dest).split(path.sep).join('/')
      })
      let journeyFinding: any = null
      if (journey?.status === 'fail') {
        const f: JourneyFailure = journey.failure
        const [shot, trace] = [toWorktree([f.screenshot])[0] ?? f.screenshot, toWorktree([f.trace])[0] ?? f.trace]
        const key = `${f.criterio}|${f.step_index}|${f.error}`
        journeySuspect = key === lastJourneyKey && !journeyRewriteUsed()
        lastJourneyKey = key
        lastJourneyFailure = f
        journeyFinding = {
          id: `journey-${f.criterio}`,
          severity: 'high',
          category: 'patch',
          target_role: 'maker',
          location: 'unknown',
          problem: `Jornada do critério ${f.criterio} quebrou no passo ${f.step_index} (${JSON.stringify(f.step)}): ${f.error}`,
          required_action: [
            `Faça o fluxo do critério ${f.criterio} funcionar como o critério pede. Olhe o print e o trace do Playwright do momento da falha antes de mudar.`
              + (journeySuspect ? ' O mesmo passo falhou do mesmo jeito na passada anterior: o roteiro pode estar errado. Se ele contradiz o critério, escreva no relatório uma linha "ROTEIRO ERRADO: <motivo>" e a prova reescreve o roteiro uma vez.' : ''),
            `Página: ${f.url}`,
            f.console.length > 0 ? `Console: ${f.console.slice(0, 8).join(' | ')}` : '',
            f.failed_requests.length > 0 ? `Requisições com erro: ${f.failed_requests.slice(0, 8).join(' | ')}` : '',
            `DOM no momento da falha: ${f.dom.slice(0, 1500)}`,
            `Print: ${shot}. Trace: ${trace}.`,
          ].filter(Boolean).join('\n'),
          evidence_refs: [shot, trace],
        }
      } else {
        lastJourneyKey = null
        journeySuspect = false
      }

      // Sempre autônoma: visual indisponível, sem veredito ou sem passada sobrando não estaciona; a parte segue para o
      // revisor e o veredito visual fica no journal
      let visualNext = fqeRes.status === 'pass' ? 'checker' : 'checker_without_visual_pass'
      const visualFinal = typeof fqeRes.evaluation?.final === 'number' ? fqeRes.evaluation.final : null
      // insistir sem ganho só queima cota. Os juízes variam uns 0,3 de uma vez para outra, então só duas passadas seguidas
      // subindo menos que isso encerram as passadas
      if (visualFinal !== null && typeof lastVisualEval?.final === 'number') visualStalls = visualFinal < lastVisualEval.final + 0.3 ? visualStalls + 1 : 0
      if (fqeRes.evaluation) lastVisualEval = fqeRes.evaluation
      const stalled = fqeRes.status === 'rework' && visualStalls >= 2
      if (stalled) visualNext = 'checker_no_visual_gain'
      if (fqeRes.status === 'rework' && visualEvals < maxVisualEvals && !stalled) {
        // no formato do achado de revisão: com `message`/`path` o normalizador zerava problema e ação e o maker
        // recebia o retrabalho vazio (25/09). Os prints vão como evidência para o maker olhar a tela.
        const shots = journeyFinding ? [] : toWorktree((fqeRes.captures || []).map((c: any) => path.resolve(String(c.path))))
        const visualFindings = journeyFinding ? [journeyFinding] : (fqeRes.defects || []).map((d: any, i: number) => ({
          id: `visual-${d.id ?? i + 1}`,
          // minor vira medium: com low o pedido de correção descartava o achado e o caminho até 7,5 nunca chegava ao maker
          severity: d.severity === 'major' ? 'high' : d.severity === 'minor' ? 'medium' : 'critical',
          category: 'patch',
          target_role: 'maker',
          // onde na tela, não arquivo: com a posição aqui a checagem de achado resolvido procurava um arquivo "/ [390px]"
          location: 'unknown',
          problem: `Avaliação visual (${d.criterion}) reprovou a tela em ${d.where}`,
          required_action: `${d.fix}. Olhe as capturas da tela antes de mudar${shots.length ? `: ${shots.join(', ')}` : ''}.`,
          evidence_refs: shots,
        }))
        openFindings = visualFindings
        previousFindings = visualFindings
        treeBeforeAttempt = treeAfterContain
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'visual_rework', unit: storyId, round, visual_evals: visualEvals, final: visualFinal, defects: visualFindings.length } })
        round++
        attempt = 0
        continue
      }
      if (visualNext !== 'checker') {
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'visual_continue', unit: storyId, round, status: fqeRes.status, reason: fqeRes.reason ?? null, next: visualNext, visual_evals: visualEvals } })
      }
      // jornada ainda quebrada sem passada sobrando nunca some calada: vai ao revisor como achado bloqueante e ele decide
      if (journeyFinding) {
        previousFindings = [journeyFinding]
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'journey_unresolved', unit: storyId, round, finding: journeyFinding.id } })
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

    let checker = checkerSlot
      ? { family: checkerSlot.family as string, model: cliModel(checkerSlot), effort: checkerSlot.effort as string | null }
      : { family: checkerRole.family as string, model: checkerRole.model_id as string | undefined, effort: null }
    let checkerDispatchFn = dispatcherFor(checker.family)

    // O Checker roda em outra família: usa o binário dela. Quem não fia `checkerResolved`
    // (provas com dublê) fica com o resolvido do Maker; `null` explícito significa que a
    // fiação tentou resolver e não achou, e aí não há revisão independente possível.
    let checkerResolved = binaryFor(checker.family)
    // Revisor que cai sem devolver revisão passa a vez ao seguinte da fila (empresa diferente de quem escreveu): o 401 de
    // um token do Codex renovado no meio da chamada estacionava a parte (missão real de anexos, 25/09)
    const checkerBackups = routed ? routed.chains.checker.filter((slot) => slot.family !== rung.family && slot !== checkerSlot) : []

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

    // Referências que o motor consegue verificar: o revisor só pode citar estas (as outras viram unverified_reference).
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

    const expectedContractRevision = (story).contract_revision ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

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
    // o revisor real não adivinha as revisões nem as refs: copia estas (a validação compara com elas)
    const reviewStory = JSON.stringify({
          ...JSON.parse(dedupStorySection(story).text),
          review_request: reviewRequest,
          echo_exactly: { contract_revision: expectedContractRevision, input_revision: { tree: treeAfterContain, digest: observedDigest } },
          // resultado oficial das provas desta árvore, rodadas pelo motor (o revisor não precisa nem consegue rodar a suíte)
          proof_results: proofResults,
          // só refs que também passam no padrão do schema: arquivo sem intervalo de linhas (file:x) é recusado na validação
          citable_refs: Array.from(verifiedRefs).filter((ref) => typeof ref === 'string' && (!ref.startsWith('file:') || /#L[1-9][0-9]*-L[1-9][0-9]*$/.test(ref))),
        }, null, 2)
    const reviewSkills = roleSkillsSection('review', contract?.skills, deps.eligibleSkills)
    const reviewPack = deps.compilePack({
      sections: { contract: JSON.stringify(contract), policy: REVIEW_POLICY, story: reviewStory, ...(reviewSkills.section ? { skills: reviewSkills.section } : {}) },
      missionDir,
      stepId: `${storyId}:r${round}:review-pack`,
      ...(reviewSkills.skills.length > 0 ? { skills: reviewSkills.skills } : {}),
    })

    // O revisor trabalha numa cópia descartável da árvore revisada: roda comandos e grava provas sem tocar a worktree do
    // maker (ADR 0047). As provas vão para a pasta da missão, durável: a cópia some no fim e a retomada relê de lá.
    // uma por worktree: missões de projetos diferentes podem repetir o id da parte
    const reviewCopyDir = path.join(os.tmpdir(), 'ade-review', `${safeId(storyId)}-r${round}-${createHash('sha256').update(path.resolve(worktreeDir)).digest('hex').slice(0, 12)}`)
    const proofsDir = path.join(missionDir, 'review-proofs', `r${round}`)
    const reviewCopy = deps.reviewCopy ?? { make: makeReviewCopy, remove: removeReviewCopy }
    await reviewCopy.make({ wtPort, tree: treeAfterContain, repoDir, dir: reviewCopyDir })
    const keepProofs = () => {
      const made = path.join(reviewCopyDir, PROOF_DIR)
      if (fs.existsSync(made)) fs.cpSync(made, proofsDir, { recursive: true })
    }

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
    
    // Uma telemetria por chamada: a retomada reaproveita a revisão já feita e não soma o gasto dela de novo.
    const appendCheckerTelemetry: (dispatch: any, outcome: 'ok' | 'rework' | 'park', stepId?: string) => Promise<void> = async (dispatch, outcome, stepId = checkerStepId): Promise<void> => {
      if (readEvents().some((e) => e.kind === 'telemetry' && e.data?.step_id === stepId)) return
      await deps.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: missionId,
        story_id: storyId,
        step_id: stepId,
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
    }

    const dispatchChecker = async (stepId: string, packPath: string = reviewPack.pack_path) => {
      if (!ranBefore(stepId)) await deps.journal.append({ kind: 'model_started', unit: storyId, data: { unit: storyId, role: 'checker', step_id: stepId, family: checker.family, model_id: checker.model ?? null, effort: checker.effort ?? null } })
      const dispatchFn = checkerDispatchFn
      if (!dispatchFn) throw new AdeError('invalid_ladder', `revisor da família ${checker.family} sem despachante`, 4)
      return dispatchFn({
        step: authorizedStep(
          deps.step,
          paidAuthorization,
          deps.now?.() ?? Date.now(),
        ),
        authorization: paidAuthorization,
        unit: storyId,
        stepId,
        packPath,
        missionDir,
        missionId,
        cwd: reviewCopyDir,
        resultFile: checkerResultFile,
        maxBudgetUsd: authorizedReservation.usd,
        model: checker.model,
        ...(checker.effort && checker.family !== 'agy' ? { effort: checker.effort } : {}),
        resolved: checkerResolved,
        env: checkerWorkerEnv,
        role: 'checker_round',
        // escrita e comandos só na cópia descartável
        sandbox: 'workspace-write',
        scratch: true,
      })
    }

    // cada revisão (a primeira e a refeita por parecer inválido) passa pela fila: quem cai passa a vez ao seguinte
    const reviewWithFallback = async (baseStep: string, packPath?: string): Promise<{ dispatch: any; stepNow: string; failure: unknown }> => {
      let stepNow = baseStep
      for (;;) {
        let dispatch: any
        let failure: unknown = null
        try {
          dispatch = await dispatchChecker(stepNow, packPath)
        } catch (err) {
          failure = err
        }
        const answered = !failure && (dispatch?.review_result || (fs.existsSync(checkerResultFile) && !dispatch?.is_error))
        if (answered) return { dispatch, stepNow, failure: null }
        const next = checkerBackups.shift()
        const nextFn = next ? dispatcherFor(next.family) : null
        const nextBin = next ? binaryFor(next.family) : null
        if (!next || !nextFn || !nextBin) return { dispatch, stepNow, failure }
        await appendCheckerTelemetry(dispatch, 'park', stepNow)
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'checker_fallback', unit: storyId, round, from: checker.family, to: next.family, reason: failure instanceof Error ? failure.message.slice(0, 200) : dispatch?.envelope_error ?? 'no_review_result' } })
        checker = { family: next.family as string, model: cliModel(next), effort: next.effort as string | null }
        checkerDispatchFn = nextFn
        checkerResolved = nextBin
        stepNow = `${baseStep}:c${checker.family}`
        fs.rmSync(checkerResultFile, { force: true })
      }
    }

    const firstReview = await reviewWithFallback(checkerStepId)
    keepProofs()
    let checkerDispatch = firstReview.dispatch
    const checkerStepNow = firstReview.stepNow
    const dispatchFailure = firstReview.failure
    if (dispatchFailure) {
      const err = dispatchFailure
      const dispatchErrorReason = err instanceof AdeError ? err.code : 'checker_dispatch_failed'
      await reviewCopy.remove(wtPort, reviewCopyDir)
      await appendCheckerTelemetry(undefined, 'park', checkerStepNow)
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

    await appendCheckerTelemetry(checkerDispatch, !reviewDoc ? 'park' : isReviewApproved(reviewDoc).approved ? 'ok' : 'rework', checkerStepNow)

    if (!reviewDoc) {
      await reviewCopy.remove(wtPort, reviewCopyDir)
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

    // o que o revisor gravou em .ade-review/ também pode ser citado
    const reviewContext = {
      contractRevision: expectedContractRevision,
      inputRevision: {
        tree: treeAfterContain,
        digest: observedDigest,
      },
      verifiedRefs: [...Array.from(verifiedRefs) as string[], ...readReviewProofs(proofsDir).refs],
    }

    let reviewApproval = isReviewApproved(reviewDoc, reviewContext)

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

    // Parecer inválido (formato ou referência que o motor não confere) é falha do revisor, não do código: pede uma nova
    // revisão antes de abrir rodada. Na missão real, um parecer recusado por formato virou rodada de código.
    if (!reviewApproval.approved && reviewApproval.errors.length > 0) {
      const retryStepId = `${checkerStepId}:t1`
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'review_invalid_retry', unit: storyId, step_id: retryStepId, errors: reviewApproval.errors.slice(0, 5) } })
      // A segunda revisão recebe os erros da primeira: sem eles o revisor repetia o mesmo erro (S2 da missão real).
      const retryPack = deps.compilePack({
        sections: {
          contract: JSON.stringify(contract),
          policy: REVIEW_POLICY,
          story: reviewStory,
          retrieved: JSON.stringify({ previous_review_rejected_by_validation: reviewApproval.errors.slice(0, 20).map((e) => ({ ...e, value: String(e.path ?? '').split('/').slice(1).reduce((v: any, k) => v?.[k], reviewDoc) ?? null })), instruction: 'Refaça o parecer corrigindo exatamente estes erros de formato e de referência; o julgamento do código é seu.' }, null, 2),
        },
        missionDir,
        stepId: `${storyId}:r${round}:review-pack-t1`,
      })
      // sem segunda revisão de ninguém da fila, vale a primeira (reprovada)
      const second = await reviewWithFallback(retryStepId, retryPack.pack_path)
      keepProofs()
      reviewContext.verifiedRefs = [...Array.from(verifiedRefs) as string[], ...readReviewProofs(proofsDir).refs]
      const retried: any = second.dispatch
      if (retried?.review_result) {
        await appendCheckerTelemetry(retried, 'rework', second.stepNow)
        checkerDispatch = retried
        reviewDoc = retried.review_result
        reviewApproval = isReviewApproved(reviewDoc, reviewContext)
        await deps.journal.append({
          kind: 'review_result',
          unit: storyId,
          data: { round, approved: reviewApproval.approved, verdict: reviewDoc?.verdict ?? 'unknown', errors: reviewApproval.errors, result: reviewDoc },
        })
      }
    }

    await reviewCopy.remove(wtPort, reviewCopyDir)
    // O revisor não altera a árvore do maker: mexeu nela, é violação de contenção, como o canário.
    if ((await wtPort.worktreeTree()) !== treeAfterContain) return await parkStory('checker_touched_maker_tree')
    // Achado que bloqueia sem prova executável vira low (ADR 0047); os arquivos das provas vão para a worktree do maker,
    // fora do commit, e a ação pedida leva o comando e a saída.
    const proofsInWorktree = `.ade/review/r${round}`
    if (fs.existsSync(proofsDir)) fs.cpSync(proofsDir, path.join(worktreeDir, proofsInWorktree), { recursive: true })
    const proven = applyReviewProofs(reviewDoc.action_items ?? reviewDoc.findings ?? [], readReviewProofs(proofsDir).proofs, proofsInWorktree)
    reviewDoc = { ...reviewDoc, action_items: proven.findings }
    // pediu mudança só com achados sem prova: nada sobra para corrigir, e outra rodada só gastaria cota
    const unprovenOnly = !reviewApproval.approved && reviewApproval.errors.length === 0 && reviewDoc.verdict === 'changes_requested'
      && proven.demoted.length > 0 && !proven.findings.map(normalizeFinding).some(isBlockingFinding)
    if (proven.demoted.length > 0) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'finding_demoted_no_evidence', unit: storyId, round, findings: proven.demoted, next: unprovenOnly ? 'deliver' : 'rework' } })
    }

    // Conflito do plano que só um humano ou o planejador decidiria (intent_gap para "human", bad_spec para "planner"):
    // nenhuma rodada do maker resolve isso e a TL-ADE é autônoma, então a versão atual (já verde nas provas oficiais) é
    // entregue na primeira revisão e o achado fica registrado como adiado. Antes esperava repetir e a S2 da missão real
    // girou oito rodadas no mesmo conflito.
    const reviewedFindings = (reviewDoc.action_items ?? reviewDoc.findings ?? []).map(normalizeFinding)
    const deferIntentGap = !reviewApproval.approved && reviewApproval.errors.length === 0 && reviewedFindings.length > 0
      && reviewedFindings.every((f: any) => (f.category === 'intent_gap' || f.category === 'bad_spec') && (f.target_role === 'human' || f.target_role === 'planner'))
    if (deferIntentGap) {
      await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'intent_gap_deferred', unit: storyId, round, findings: reviewedFindings.map((f: any) => ({ id: f.id, problem: f.problem, required_action: f.required_action })) } })
    }

    if (reviewApproval.approved || deferIntentGap || unprovenOnly) {
      // Itens que o revisor adiou (requisito impossível dentro do escopo) ficam registrados para o relatório.
      const deferredItems = (reviewDoc.deferred ?? []).map(normalizeFinding)
      if (reviewApproval.approved && deferredItems.length > 0) {
        await deps.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'review_deferred', unit: storyId, round, items: deferredItems.map((f: any) => ({ id: f.id, problem: f.problem, required_action: f.required_action })) } })
      }
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

      // Base que andou durante a parte: o commit revisado vai para cima dela na worktree da parte, sem conflito.
      let deliverCommit = commitSha
      let deliverBase = baseBefore
      const rebased = await rebaseOntoMovedBase({ basePort, wtPort, baseRef, baseBefore, commit: commitSha })
      if (rebased) {
        await journal.append({ kind: 'decision', unit: storyId, data: { decision: 'delivery_rebased', unit: storyId, from: commitSha, commit: rebased.commit, onto: rebased.onto, base_before: baseBefore } })
        deliverCommit = rebased.commit
        deliverBase = rebased.onto
      }

      const delivery = await deliverStory({
        journal,
        events: readEvents(),
        gitPort: basePort,
        storyId,
        baseRef,
        baseBefore: deliverBase,
        reviewedCommit: deliverCommit,
      })
      const deliveryStatus = delivery.delivered ? 'delivered' : 'awaiting_operator'

      await journal.append({
        kind: 'story_done',
        unit: storyId,
        data: {
          status: deliveryStatus,
          reason: delivery.delivered ? null : delivery.reason,
          commit: delivery.commit ?? deliverCommit,
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
        commit: delivery.commit ?? deliverCommit,
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

/** Config do projeto em .ade/config.json; ausente ou ilegível vale {}. */
function readProjectConfig(repoDir: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, '.ade', 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}
