// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchClaude } from '../adapters/claude/index.js'
import { checkCanary, plantCanary } from '../contain/canary.js'
import { contain } from '../contain/contain.js'
import { runStory } from '../engine.js'
import { loadPlan } from '../engine/plan-load.js'
import { prepareStory } from '../engine/prepare.js'
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

    lease = await acquireLease({ missionDir })

    let resolved
    /** @type {Record<string, string>} */
    let workerEnv = {}
    if (env.ADE_FAKE_CLI === '1') {
      resolved = {
        exe: process.execPath,
        prefixArgs: [fileURLToPath(new URL('../adapters/fake/cli.js', import.meta.url))],
      }
      workerEnv = {
        ADE_FAKE_SCENARIO: env.ADE_FAKE_SCENARIO ?? '',
        ADE_FAKE_ROLE: 'maker',
      }
    } else {
      resolved = resolveBinary('claude')
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

    const story = loaded.stories[0]
    if (!story) {
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
      dispatchClaude,
      reconcileAll,
      resolved,
      workerEnv,
      capabilities,
      env,
      now: () => Date.now(),
    }

    const storyResult = await runStory(engineDeps, {
      loaded,
      story,
      repoDir,
      missionDir,
    })

    return storyResult.exitCode
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
