// @ts-check
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createLocalPreflightPorts } from '../adapters/local/preflight.ts'
import { createLocalQuotaPort } from '../adapters/local/quota.ts'
import { dispatchClaude } from '../adapters/claude/index.ts'
import { dispatchCodex } from '../adapters/codex/index.ts'
import { checkCanary, plantCanary } from '../contain/canary.ts'
import { contain } from '../contain/contain.ts'
import { runStory } from '../engine.ts'
import { loadPlan } from '../engine/plan-load.ts'
import { runHardPreconditions, runPreflight } from '../engine/preflight.ts'
import { guardExternalEffects, runUnattendedBatch } from '../engine/loop.ts'
import { prepareStory } from '../engine/prepare.ts'
import { installShutdownDrain, readMissionControl } from '../engine/control.ts'
import { resumeMission } from '../engine/resume.ts'
import { checkApproval } from '../engine/schedule.ts'
import { replanRemaining } from '../mission/plan-lifecycle.ts'
import { createEvalRunner } from '../evals/eval-runner.ts'
import { createGateRunner } from '../gates/gates.ts'
import { createGitPort } from '../git/gitport.ts'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { openJournal, readJournal } from '../journal/journal.ts'
import { acceptStaleVersion as acceptStaleVersionFn, assertStampCurrent, buildRuntimeStamp } from '../journal/stamp.ts'
import { acquireLease } from '../lease/lease.ts'
import { compilePack } from '../pack/pack.ts'
import { resolveBinary } from '../runner/resolve-binary.ts'
import { activeWorkerPids, terminateProcessTree } from '../runner/spawn.ts'
import { reconcileAll } from '../step/reconcile.ts'
import { createStepRunner } from '../step/step.ts'
import { loadApprovedSkills } from '../skills/catalog.js'
import { closeMissionSummary } from '../telemetry/telemetry.ts'

const execFileAsync = promisify(execFile)

const LEASE_TTL_MS = 15_000
/** Prazo seguro para o worker em curso terminar sozinho depois de um sinal de encerramento. */
const SHUTDOWN_GRACE_MS = 30_000

/**
 * Portas das precondições duras da noite desatendida. Todas determinísticas e locais: nenhuma
 * delas dispara chamada paga, porque a recusa acontece antes do primeiro despacho.
 *
 * @param {{
 *   repoDir: string,
 *   missionDir: string,
 *   missionId: string,
 *   loaded: import('../engine/plan-load.ts').LoadedPlan,
 *   events: Array<Record<string, any>>,
 *   gitPort: any,
 * }} input
 * @returns {Record<string, { check: () => Promise<import('../engine/preflight.ts').PreflightCheckResult> }>}
 */
function createHardPreconditionPorts({ repoDir, missionDir, missionId, loaded, events, gitPort }) {
  const ready = { status: /** @type {const} */ ('ready'), reason: null }
  /** @param {string} reason */
  const blocked = (reason) => ({ status: /** @type {const} */ ('blocked'), reason })

  return {
    gates_active: {
      check: async () => {
        const gatesPath = path.join(missionDir, 'gates.json')
        if (!fs.existsSync(gatesPath)) return blocked(`gates ausentes: ${gatesPath}`)
        let gates
        try {
          gates = JSON.parse(fs.readFileSync(gatesPath, 'utf8'))
        } catch (err) {
          return blocked(`gates ilegíveis: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!Array.isArray(gates) || gates.length === 0) return blocked('nenhum gate ativo no plano')
        return ready
      },
    },
    eval_baseline_green: {
      check: async () => {
        const scripts = loaded.plan?.briefing?.discovery?.scripts
        const testArgv = scripts?.test_argv ?? (Array.isArray(scripts?.test) ? scripts.test : null)
        let cmd
        /** @type {string[]} */
        let args = []
        let displayCmd = ''
        if (Array.isArray(testArgv) && testArgv.length > 0) {
          [cmd, ...args] = testArgv
          displayCmd = testArgv.join(' ')
        } else if (typeof scripts?.test === 'string' && scripts.test.trim() !== '') {
          const raw = scripts.test.trim()
          displayCmd = raw
          if (/["'`]|&&|\||;/.test(raw)) {
            return blocked(`formato de script não suportado: ${raw} (requer argv estruturado ou comando simples sem aspas ou encadeamento)`)
          }
          [cmd, ...args] = raw.split(/\s+/)
        } else {
          return blocked('baseline de eval sem comando de prova na descoberta')
        }
        try {
          await execFileAsync(cmd, args, {
            cwd: repoDir,
            shell: false,
            windowsHide: true,
            maxBuffer: 1 << 24,
            timeout: 600_000,
          })
        } catch (err) {
          const code = /** @type {any} */ (err)?.code
          return blocked(`baseline de eval não verde (${displayCmd} saiu com ${code ?? 'erro'})`)
        }
        return ready
      },
    },
    rollback_point: {
      check: async () => {
        const ref = `refs/ade/rollback/${missionId}`
        const res = await gitPort.run(['show-ref', '--verify', ref], {
          maxBuffer: 1 << 20,
          okCodes: [0, 1, 128],
        })
        return res.code === 0 ? ready : blocked(`ponto de rollback ausente: ${ref}`)
      },
    },
    worktree_isolation: {
      check: async () => {
        const outsideDir = path.join(os.tmpdir(), `ade-canary-${missionId}`)
        try {
          const canary = plantCanary({ worktreeDir: repoDir, outsideDir, unitId: 'preflight' })
          if (checkCanary(canary).escaped) return blocked(`canário escapou para ${canary.filePath}`)
        } catch (err) {
          return blocked(`canário não pôde ser plantado: ${err instanceof Error ? err.message : String(err)}`)
        }
        return ready
      },
    },
    permitted_effects: {
      check: async () => {
        const approval = [...events]
          .reverse()
          .find((e) => e.kind === 'decision' && e.data?.decision === 'plan_approved')
        if (!approval) return blocked('plano sem aprovação congelada no journal')
        const approved = approval.data?.permitted_effects
        if (!Array.isArray(approved)) return blocked('aprovação sem permitted_effects')
        const planned = loaded.plan?.authorization?.permitted_effects ?? []
        const widened = planned.filter((/** @type {string} */ e) => !approved.includes(e))
        if (widened.length > 0) return blocked(`efeitos não aprovados: ${widened.join(', ')}`)
        return ready
      },
    },
  }
}

/**
 * @param {string} missionDir
 * @returns {number | null}
 */
export function heartbeatAgeMs(missionDir) {
  try {
    return Date.now() - fs.statSync(path.join(missionDir, 'lease', 'heartbeat')).mtimeMs
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
}

/**
 * @param {{
 *   plan: string,
 *   repo?: string,
 *   acceptStaleVersion: boolean,
 *   unattended?: boolean,
 * }} options
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stdout?: ((s: string) => void) | { write: (s: string) => void },
 *   stderr?: ((s: string) => void) | { write: (s: string) => void },
 *   quotaPort?: any,
 *   dispatchClaude?: any,
 *   [key: string]: any,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runCommand(options, deps = {}) {
  const loaded = loadPlan(options.plan)
  const repoDir = path.resolve(options.repo ?? process.cwd())
  const missionId = loaded.plan.mission_id
  const missionDir = path.join(repoDir, '.ade', 'missions', missionId)

  const env = deps.env ?? process.env
  const homeDir = env.ADE_HOME ?? os.homedir()
  const capsPath = path.join(homeDir, '.ade', 'capabilities.json')

  let capabilities
  try {
    const raw = fs.readFileSync(capsPath, 'utf8')
    capabilities = JSON.parse(raw)
  } catch {
    throw new AdeError('capabilities_missing', 'rode ade doctor', 4)
  }

  const configPath = path.join(repoDir, '.ade', 'config.json')
  let configObj = {}
  if (fs.existsSync(configPath)) {
    try {
      configObj = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      // fallback para objeto vazio
    }
  }

  const configDigest = digest16(configObj)
  const capabilitiesDigest = digest16(capabilities)
  const runtimeStamp = buildRuntimeStamp({ configDigest, capabilitiesDigest })

  /** @type {import('../journal/journal.ts').Journal | null} */
  let journal = null
  /** @type {import('../lease/lease.ts').Lease | null} */
  let lease = null
  const journalPath = path.join(missionDir, 'journal.jsonl')
  // O resumo só fecha missões que chegaram a despachar; recusa de versão ou lease não escreve.
  let missionStarted = false
  /** @type {number | null} */
  let missionExitCode = null
  // Desligamento, atualização ou reinício entram pela mesma drenagem cooperativa da pausa.
  const shutdown = installShutdownDrain(deps.processSignals ?? process, (signal) => {
    for (const pid of activeWorkerPids()) {
      terminateProcessTree({ pid, timeoutMs: SHUTDOWN_GRACE_MS })
        .then((result) => journal?.append({ kind: 'process_tree_terminated', data: { signal, ...result } }))
        .catch((err) => {
          process.stderr.write(`ade run: falha ao registrar encerramento do worker ${pid}: ${err instanceof Error ? err.message : err}
`)
        })
    }
  })

  try {
    journal = openJournal({ missionDir, runtimeStamp })

    const { events: existingEvents } = readJournal(journalPath)
    if (options.acceptStaleVersion) {
      await acceptStaleVersionFn(journal, existingEvents)
    } else {
      assertStampCurrent(existingEvents)
    }

    const priorHeartbeatAge = heartbeatAgeMs(missionDir)
    lease = await acquireLease({ missionDir, adoptDeadOwnerWithinTtl: true, ttlMs: LEASE_TTL_MS })
    if (lease.adopted) {
      await journal.append({
        kind: 'lease_adopted',
        data: {
          previous_owner: lease.previousOwner,
          reason: priorHeartbeatAge !== null && priorHeartbeatAge > LEASE_TTL_MS ? 'heartbeat_expired' : 'owner_dead',
          heartbeat_age_ms: priorHeartbeatAge === null ? null : Math.round(priorHeartbeatAge),
        },
      })
    }

    let resolved
    /** @type {{ exe: string, prefixArgs: string[] } | null} */
    let checkerResolved
    /** @type {Record<string, string>} */
    let workerEnv = {}
    if (env.ADE_FAKE_CLI === '1') {
      resolved = {
        exe: process.execPath,
        prefixArgs: [fileURLToPath(new URL('../adapters/fake/cli.ts', import.meta.url))],
      }
      checkerResolved = resolved
      workerEnv = {
        ADE_FAKE_SCENARIO: env.ADE_FAKE_SCENARIO ?? '',
        ADE_FAKE_ROLE: 'maker',
      }
    } else {
      resolved = resolveBinary('claude')
      // O Checker é de outra família: precisa do próprio binário. Sem ele não há revisão
      // independente possível, e o motor estaciona a unidade em vez de rodar o binário errado.
      try {
        checkerResolved = resolveBinary('codex')
      } catch (err) {
        checkerResolved = null
        await journal.append({
          kind: 'checker_binary_unavailable',
          data: { family: 'codex', error: err instanceof Error ? err.message : String(err) },
        })
      }
      workerEnv = {}
    }

    const gitPort = createGitPort({ worktreeDir: repoDir })
    const verdicts = await reconcileAll({ journal, missionDir, gitPort })
    if (verdicts && verdicts.length > 0) {
      await journal.append({
        kind: 'run_resumed',
        data: {
          verdicts: verdicts.map((v) => ({
            step_id: v.step_id,
            verdict: v.verdict,
            reason: v.reason,
          })),
        },
      })
    }

    if (!loaded.stories || loaded.stories.length === 0) {
      throw new AdeError('plan_without_stories', 'plano sem stories', 4)
    }

    const approvedSkillIds = loaded.plan.authorization?.eligible_skills || []
    let eligibleSkills = []
    /** @type {any[]} */
    let eligibleSkillSnapshot = []
    let skillCatalogError = null
    if (approvedSkillIds.length > 0) {
      try {
        const loadedSkills = loadApprovedSkills({
          catalogDir: deps.catalogDir || path.join(homeDir, '.ade', 'catalog'),
          approvedSkills: approvedSkillIds,
        })
        eligibleSkills = loadedSkills.skills
        eligibleSkillSnapshot = loadedSkills.snapshot
      } catch (err) {
        skillCatalogError = err instanceof Error ? err.message : String(err)
      }
    }

    // A noite desatendida só começa com todas as precondições duras verdes. A recusa acontece
    // antes de qualquer despacho, então nenhuma chamada paga é feita para descobrir o bloqueio.
    if (options.unattended) {
      // A aprovação congelada é a primeira precondição: plano divergente é recusado antes de
      // qualquer comando vindo do plano (como o baseline de eval) chegar a rodar.
      const approval = checkApproval({ skillCatalogError, eligibleSkillSnapshot }, loaded, existingEvents, missionDir)
      if (!approval.valid) {
        await journal.append({
          kind: 'unattended_refused',
          data: {
            failures: [{ id: 'approval_frozen', reason: approval.reason ?? 'approval_divergent' }],
            next_action: approval.nextAction ?? 'ade approve',
          },
        })
        return 2
      }
      const hard = await runHardPreconditions({
        checks: createHardPreconditionPorts({
          repoDir,
          missionDir,
          missionId,
          loaded,
          events: existingEvents,
          gitPort,
        }),
      })
      if (!hard.ready) {
        await journal.append({
          kind: 'unattended_refused',
          data: { failures: hard.failures, checks: hard.checks },
        })
        return 2
      }
    }

    // Na noite desatendida todo efeito externo passa pelo guarda: o que não está em
    // `permitted_effects` do plano aprovado é recusado antes de acontecer. O `ade run` normal
    // mantém o executor de sempre (`--unattended` é opt-in).
    const { step: runStep } = createStepRunner({ journal, missionDir })
    const step = options.unattended
      ? guardExternalEffects({
        step: runStep,
        journal,
        permittedEffects: loaded.plan.authorization?.permitted_effects ?? [],
      })
      : runStep
    missionStarted = true
    const engineDeps = {
      journal,
      step,
      gitPortFor: (/** @type {string} */ dir) => createGitPort({ worktreeDir: dir }),
      prepareStory,
      createEvalRunner,
      createGateRunner,
      compilePack,
      contain,
      plantCanary,
      checkCanary,
      dispatchClaude: deps.dispatchClaude ?? dispatchClaude,
      dispatchCodex: deps.dispatchCodex ?? dispatchCodex,
      resolved,
      checkerResolved,
      workerEnv,
      quotaPort: deps.quotaPort ?? createLocalQuotaPort({
        receiptPath: path.join(homeDir, '.ade', 'quota-receipt.json'),
      }),
      capabilities,
      env,
      now: deps.now ?? (() => Date.now()),
      preflight: async (/** @type {{ story: any, loaded: any, repoDir: string, events: any[] }} */ { story, loaded, repoDir, events }) => {
        const checks = createLocalPreflightPorts({
          repoDir,
          story,
          loaded,
          capabilities,
          gitPort,
          execFile,
          statfs: fs.promises.statfs,
          now: deps.now ?? (() => Date.now()),
          env,
          credentialRequired: env.ADE_FAKE_CLI !== '1' && !deps.dispatchClaude,
        })
        const planned_paid_calls = Math.min(
          loaded.plan.budget.max_model_calls,
          story.contract.budget.max_model_calls,
          loaded.lineageCallsRemaining ?? Infinity,
        )
        const consumed_paid_calls = events.filter((/** @type {any} */ e) => e.kind === 'budget_reserved').length
        return runPreflight({
          checks,
          planned_paid_calls,
          consumed_paid_calls,
        })
      },
      runStory: deps.runStory ?? runStory,
      replanRemaining: deps.replanRemaining ?? replanRemaining,
      loadPlan: deps.loadPlan ?? loadPlan,
      runtimeStamp,
      lease,
      shutdown,
      eligibleSkills,
      eligibleSkillSnapshot,
      skillCatalogError,
    }

    if (options.unattended) {
      const batch = await runUnattendedBatch(engineDeps, { loaded, repoDir, missionDir })
      missionExitCode = batch.exitCode
      return batch.exitCode
    }

    const hasApproval = existingEvents.some(
      (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
    )
    if (
      loaded.stories.length === 1 &&
      !hasApproval &&
      approvedSkillIds.length === 0 &&
      readMissionControl({ missionDir }).state === 'RUNNING'
    ) {
      const story = loaded.stories[0]
      const storyResult = await (deps.runStory ?? runStory)(engineDeps, {
        loaded,
        story,
        repoDir,
        missionDir,
      })
      missionExitCode = storyResult.exitCode
      return storyResult.exitCode
    }

    const missionResult = await resumeMission({ loaded, repoDir, missionDir, deps: engineDeps })

    missionExitCode = missionResult.exitCode
    return missionResult.exitCode
  } finally {
    shutdown.dispose()
    if (journal && missionStarted) {
      // Um único resumo por missão: 0 conclui, 3 estaciona, o resto (inclusive exceção) interrompe.
      const summary = closeMissionSummary({
        mission: { id: missionId, context: /** @type {any} */ (loaded.plan).context },
        events: readJournal(journalPath).events,
        outcome: missionExitCode === 0 ? 'completed' : missionExitCode === 3 ? 'parked' : 'interrupted',
        capabilitiesDigest,
      })
      if (summary) await journal.append(summary)
    }
    if (lease) {
      try {
        await lease.release()
      } catch {
        // ignora erro ao liberar lease
      }
    }
    if (journal) {
      try {
        await journal.close()
      } catch {
        // ignora erro ao fechar journal
      }
    }
  }
}
