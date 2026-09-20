// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from './journal/errors.js'
import { readJournal } from './journal/journal.js'
import { assertCallBudget, authorizePaidCall, checkUsdCap, observedUsd, reserveCalls } from './engine/budget.js'
import { maybeEngineFault } from './engine/faults.js'
import { findStoryCommitted, findStoryStarted } from './engine/resume.js'
import { dedupStorySection } from './pack/dedup.js'

/**
 * Famílias de modelos com canário aprovado no Slice 1.
 *
 * @type {readonly string[]}
 */
export const CANARY_FAMILIES = ['claude']

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
 * @param {any} [deps.reconcileAll] Reconciliador de intenções abertas.
 * @param {{ exe: string, prefixArgs: string[] }} deps.resolved Binário resolvido e prefixos.
 * @param {Record<string, string>} deps.workerEnv Variáveis de ambiente para o worker.
 * @param {{ probe_ok: boolean | null }} deps.capabilities Estado da sonda de capacidades do doctor.
 * @param {NodeJS.ProcessEnv} [deps.env] Variáveis de ambiente da execução.
 * @param {() => number} [deps.now] Provedor de timestamp atual em ms.
 * @param {{ readReceipt: ({ family, now }: { family: string, now: number }) => Promise<any> }} deps.quotaPort Porta de recibos oficiais de cota.
 * @param {(opts: { story: any, loaded: any, repoDir: string, events: any[] }) => Promise<import('./engine/preflight.js').PreflightSummary>} [deps.preflight] Verificador de preflight.
 *
 * @param {Object} input Parâmetros de entrada da story e do plano.
 * @param {import('./engine/plan-load.js').LoadedPlan} input.loaded Plano e contratos carregados.
 * @param {import('./engine/plan-load.js').LoadedStory} input.story Story a ser executada.
 * @param {string} input.repoDir Diretório raiz do repositório alvo.
 * @param {string} input.missionDir Diretório de trabalho da missão em .ade/missions/<mission_id>.
 *
 * @returns {Promise<{ status: 'committed' | 'awaiting_operator', exitCode: 0 | 3, reason: string | null, commit: string | null }>}
 */
export async function runStory(deps, input) {
  const { loaded, story, repoDir, missionDir } = input
  const missionId = loaded.plan.mission_id
  const storyId = story.id
  const contract = story.contract
  const env = deps.env ?? process.env

  if (typeof deps.preflight !== 'function') {
    throw new AdeError('preflight_missing', 'preflight obrigatório não configurado', 4)
  }

  // Guardas iniciais antes de qualquer step
  const makerFamily = contract.roles?.maker?.family
  if (!makerFamily || !CANARY_FAMILIES.includes(makerFamily)) {
    throw new AdeError('family_without_canary', `família sem canário aprovado: ${makerFamily}`, 4)
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
  const eventsBeforeReservation = readEvents()
  const previousReservation = eventsBeforeReservation.find(
    (event) =>
      event?.kind === 'budget_reserved' &&
      (event.unit === storyId || event.data?.unit === storyId) &&
      event.data?.quota_receipt,
  )
  const quotaReceipt = previousReservation?.data?.quota_receipt ?? await deps.quotaPort.readReceipt({
    family: makerFamily,
    now: deps.now?.() ?? Date.now(),
  })
  const hasPreviousReservation = Boolean(previousReservation)
  const requestedUsd = hasPreviousReservation
    ? 0
    : contract.budget?.max_usd ?? loaded.missionBudget.max_usd
  const paidCall = authorizePaidCall({
    events: eventsBeforeReservation,
    mission_budget: { ...loaded.missionBudget, max_usd: undefined },
    story_budget: contract.budget,
    family: makerFamily,
    phase: 'implementation',
    requested_usd: requestedUsd,
    requested_calls: hasPreviousReservation ? 0 : 1,
    requested_turns: hasPreviousReservation ? 0 : 1,
    quota_receipt: quotaReceipt,
    now: deps.now?.() ?? Date.now(),
  })

  if (!paidCall.allowed) {
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

  const maxModelCalls = Math.min(
    loaded.plan.budget.max_model_calls,
    contract.budget.max_model_calls,
  )
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

  /** @type {string} */
  let worktreeDir
  /** @type {import('./git/gitport.js').GitPort} */
  let wtPort
  /** @type {string} */
  let treeBefore

  const started = findStoryStarted(readEvents(), storyId)
  if (started && fs.existsSync(started.worktree_dir)) {
    worktreeDir = started.worktree_dir
    treeBefore = started.tree_before
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
    // Step prepare
    const prepareStepResult = await deps.step(
      {
        unit: storyId,
        id: `${storyId}:prepare`,
        effect_class: 'prepare',
        input: { storyId, missionId },
      },
      () => deps.prepareStory({ repoDir, missionId, storyId }),
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
      },
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

  // Compila pack e anexa pack_manifest
  const dedup = dedupStorySection(story)
  const packResult = deps.compilePack({
    missionDir,
    stepId: `${storyId}:r1:maker`,
    sections: {
      contract: typeof contract === 'string' ? contract : JSON.stringify(contract, null, 2),
      policy: JSON.stringify(loaded.plan.authorization ?? {}, null, 2),
      story: dedup.text,
    },
    savedBytes: dedup.saved_bytes,
  })

  await deps.journal.append({
    kind: 'pack_manifest',
    unit: storyId,
    data: packResult.manifest,
  })

  // Canário fora da worktree
  const canary = await deps.plantCanary({
    worktreeDir,
    outsideDir: path.join(missionDir, 'canary'),
    unitId: storyId,
  })

  maybeEngineFault('before_spawn', env)

  const resultFile = path.join(missionDir, 'maker-result.json')
  const workerEnv = {
    ...deps.workerEnv,
    ...(deps.workerEnv && !deps.workerEnv.ADE_FAKE_RESULT_FILE
      ? { ADE_FAKE_RESULT_FILE: resultFile }
      : {}),
  }

  const makerStartedAt = deps.now?.() ?? Date.now()
  const dispatch = await deps.dispatchClaude({
    step: deps.step,
    unit: storyId,
    stepId: `${storyId}:r1:maker`,
    packPath: packResult.pack_path,
    missionDir,
    missionId,
    cwd: worktreeDir,
    resultFile,
    maxBudgetUsd: loaded.missionBudget.max_usd,
    resolved: deps.resolved,
    env: workerEnv,
  })
  const makerWallMs = Math.max(0, (deps.now?.() ?? Date.now()) - makerStartedAt)

  maybeEngineFault('after_maker_effect', env)

  maybeEngineFault('before_contain', env)

  const tree = await wtPort.worktreeTree()
  const scopePaths = contract.guardrails?.scope_paths ?? []
  const doNotTouch = contract.guardrails?.do_not_touch ?? []
  const sensitivePaths = contract.guardrails?.sensitive_paths ?? []

  const containStepResult = await deps.step(
    {
      unit: storyId,
      id: `${storyId}:contain`,
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

  // Canário sempre é checado após o Maker, mesmo que a contenção também recuse:
  // um escape para fora da worktree não pode ficar mascarado por uma violação de escopo.
  const canaryResult = await deps.checkCanary(canary)
  if (canaryResult.escaped) {
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
  await deps.journal.append({
    kind: 'telemetry',
    unit: storyId,
    data: {
      role: 'maker',
      step_id: `${storyId}:r1:maker`,
      maker_wall_ms: makerWallMs,
      tokens: dispatch?.tokens ?? { source: 'unavailable' },
    },
  })

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
      (/** @type {any} */ r) => r.status !== 'passed' && r.status !== 'ok',
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

  for (const evalDef of story.evals) {
    const evalRecord = await runGreenEval({
      eval: evalDef,
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

  await deps.journal.append({
    kind: 'story_done',
    unit: storyId,
    data: {
      status: 'committed',
      commit: commitSha,
      spec_revision: story.spec_revision,
      unit: storyId,
    },
  })

  return {
    status: 'committed',
    exitCode: 0,
    reason: null,
    commit: commitSha,
  }
}
