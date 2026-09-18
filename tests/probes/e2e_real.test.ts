import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { observedUsd } from '../../src/engine/budget.js'
import { readJournal } from '../../src/journal/journal.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'
import { checkProbeJournal, probeEnv, writeProbePlan, writeProbeSandbox } from './probe-plan.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BIN_ADE = path.resolve(ROOT, 'bin/ade.js')

const tmpDirs: string[] = []
const repoDirs: string[] = []

afterAll(() => {
  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
})

test.skipIf(process.env.ADE_PROBES !== '1')(
  'run_plan_closes_a_real_ade_story_with_claude',
  async () => {
    const env = probeEnv(process.env)

    const docRes = spawnSync(process.execPath, [BIN_ADE, 'doctor'], {
      env,
      encoding: 'utf8',
      maxBuffer: 1_048_576,
    })
    expect(docRes.status).toBe(0)

    const repo = makeRepo()
    repoDirs.push(repo.dir)

    writeProbeSandbox(repo.dir)
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'commit inicial'])

    const planDir = makeTmpDir('probe-plan-real-')
    tmpDirs.push(planDir)
    const planPath = writeProbePlan(planDir)

    const runRes = spawnSync(
      process.execPath,
      [BIN_ADE, 'run', '--plan', planPath, '--repo', repo.dir],
      {
        env,
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 1_048_576,
      },
    )
    expect(runRes.status).toBe(0)

    const journalPath = path.join(repo.dir, '.ade/missions/probe-m1/journal.jsonl')
    const journalResult = readJournal(journalPath)
    const events = Array.isArray(journalResult) ? journalResult : journalResult.events
    expect(checkProbeJournal(events)).toEqual([])

    expect(() =>
      repo.git(['rev-parse', '--verify', 'refs/heads/ade/probe-m1/PROBE-1']),
    ).not.toThrow()

    const { observed_usd } = observedUsd(events)
    const telemetry = events.find((e: any) => e?.kind === 'telemetry')
    const maker_wall_ms = telemetry?.data?.maker_wall_ms
    console.log(`probe: usd=${observed_usd} maker_wall_ms=${maker_wall_ms}`)
  },
  900_000,
)
