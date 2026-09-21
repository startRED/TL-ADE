// @ts-check
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalPreflightPorts } from '../adapters/local/preflight.js'
import { createLocalQuotaPort } from '../adapters/local/quota.js'
import { dispatchClaude } from '../adapters/claude/index.js'
import { dispatchCodex } from '../adapters/codex/index.js'
import { checkCanary, plantCanary } from '../contain/canary.js'
import { contain } from '../contain/contain.js'
import { runStory } from '../engine.js'
import { loadPlan } from '../engine/plan-load.js'
import { runPreflight } from '../engine/preflight.js'
import { prepareStory } from '../engine/prepare.js'
import { runSequentialMission } from '../engine/schedule.js'
import { replanRemaining } from '../mission/plan-lifecycle.js'
import { createEvalRunner } from '../evals/eval-runner.js'
import { createGateRunner } from '../gates/gates.js'
import { createGitPort } from '../git/gitport.js'
import { digest16 } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'
import { openJournal, readJournal } from '../journal/journal.js'
import { acceptStaleVersion as acceptStaleVersionFn, assertStampCurrent, buildRuntimeStamp } from '../journal/stamp.js'
import { acquireLease } from '../lease/lease.js'
import { compilePack } from '../pack/pack.js'
import { resolveBinary } from '../runner/resolve-binary.js'
import { reconcileAll } from '../step/reconcile.js'
import { createStepRunner } from '../step/step.js'

const LEASE_TTL_MS = 15_000

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

  /** @type {import('../journal/journal.js').Journal | null} */
  let journal = null
  /** @type {import('../lease/lease.js').Lease | null} */
  let lease = null

  try {
    journal = openJournal({ missionDir, runtimeStamp })

    const journalPath = path.join(missionDir, 'journal.jsonl')
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
        prefixArgs: [fileURLToPath(new URL('../adapters/fake/cli.js', import.meta.url))],
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

    const { step } = createStepRunner({ journal, missionDir })
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
    }

    const hasApproval = existingEvents.some(
      (e) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
    )
    if (loaded.stories.length === 1 && !hasApproval) {
      const story = loaded.stories[0]
      const storyResult = await (deps.runStory ?? runStory)(engineDeps, {
        loaded,
        story,
        repoDir,
        missionDir,
      })
      return storyResult.exitCode
    }

    const missionResult = await runSequentialMission(engineDeps, {
      loaded,
      repoDir,
      missionDir,
    })

    return missionResult.exitCode
  } finally {
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
