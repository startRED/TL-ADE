import { describe, expect, test } from 'vitest'
import { configDefaults } from 'vitest/config'
import { buildClaudeArgs } from '../src/adapters/claude/argv.js'
import { observedUsd } from '../src/engine/budget.js'
import { loadPlan } from '../src/engine/plan-load.js'
import { selectTests } from '../vitest.config.mjs'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'
import { checkProbeJournal, probeEnv, writeProbePlan } from './probes/probe-plan.js'

describe('probes config', () => {
  test('default_suite_excludes_probes', () => {
    expect(selectTests({})).toEqual({
      include: ['tests/**/*.test.ts'],
      exclude: [...configDefaults.exclude, 'tests/probes/**'],
    })
  })

  test('probes_target_includes_only_probes', () => {
    expect(selectTests({ ADE_PROBES: '1' })).toEqual({
      include: ['tests/probes/**/*.test.ts'],
      exclude: [...configDefaults.exclude],
    })
  })

  test('probes_flag_other_than_1_is_ignored', () => {
    expect(selectTests({ ADE_PROBES: '0' })).toEqual(selectTests({}))
    expect(selectTests({ ADE_PROBES: 'true' })).toEqual(selectTests({}))
  })
})

describe('probe plan and helpers', () => {
  test('probe_plan_is_loadable_with_low_budget', () => {
    const tmp = makeTmpDir('probe-plan-')
    try {
      const planPath = writeProbePlan(tmp)
      const loaded = loadPlan(planPath)
      expect(loaded.stories).toHaveLength(1)
      expect(loaded.stories[0].id).toBe('PROBE-1')
      expect(loaded.stories[0].contract.guardrails.scope_paths).toEqual(['src/**'])
      expect(loaded.missionBudget.max_usd).toBe(1)
    } finally {
      removeTmpDir(tmp)
    }
  })

  test('probe_budget_reaches_claude_as_max_budget_usd', () => {
    const tmp = makeTmpDir('probe-budget-')
    try {
      const planPath = writeProbePlan(tmp)
      const loaded = loadPlan(planPath)
      const argv = buildClaudeArgs({
        sessionId: 's',
        packPath: 'p.md',
        maxBudgetUsd: loaded.missionBudget.max_usd,
      })
      const maxBudgetIdx = argv.indexOf('--max-budget-usd')
      expect(maxBudgetIdx).toBeGreaterThanOrEqual(0)
      expect(argv[maxBudgetIdx + 1]).toBe('1')
    } finally {
      removeTmpDir(tmp)
    }
  })

  test('probe_journal_check_passes_on_complete_journal', () => {
    const events = [
      { kind: 'story_done', data: { status: 'committed' } },
      {
        kind: 'step_result',
        step_id: 'PROBE-1:r1:maker',
        result: { usage: { cost_usd: 0.3 } },
      },
      { kind: 'pack_manifest', data: { dedup: { contract_bytes: 100, saved_bytes: 50 } } },
      { kind: 'telemetry', data: { tokens: { source: 'reported' } } },
    ]
    expect(observedUsd(events).observed_usd).toBe(0.3)
    expect(checkProbeJournal(events)).toEqual([])
  })

  test('probe_journal_check_lists_missing_items', () => {
    const missingStoryDoneAndCost = [
      {
        kind: 'step_result',
        step_id: 'PROBE-1:r1:maker',
        result: { usage: { cost_usd: 0 } },
      },
      { kind: 'pack_manifest', data: { dedup: { contract_bytes: 100, saved_bytes: 50 } } },
      { kind: 'telemetry', data: { tokens: { source: 'reported' } } },
    ]
    expect(checkProbeJournal(missingStoryDoneAndCost)).toEqual(['story_done', 'observed_usd'])
    expect(checkProbeJournal([])).toEqual([
      'story_done',
      'observed_usd',
      'pack_dedup',
      'tokens_reported',
    ])

    const exceededCost = [
      { kind: 'story_done', data: { status: 'committed' } },
      {
        kind: 'step_result',
        step_id: 'PROBE-1:r1:maker',
        result: { usage: { cost_usd: 1.5 } },
      },
      { kind: 'pack_manifest', data: { dedup: { contract_bytes: 100, saved_bytes: 50 } } },
      { kind: 'telemetry', data: { tokens: { source: 'reported' } } },
    ]
    expect(checkProbeJournal(exceededCost)).toEqual(['observed_usd'])
  })

  test('probe_env_drops_fake_and_home', () => {
    const inputEnv = {
      ADE_FAKE_CLI: 'x',
      ADE_FAKE_SCENARIO: 's',
      ADE_HOME: 'y',
      PATH: 'p',
    }
    const filtered = probeEnv(inputEnv)
    expect(filtered).toEqual({ PATH: 'p' })
    expect(inputEnv.ADE_FAKE_CLI).toBe('x')
  })
})

