import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../../src/journal/errors.ts'
import { EXTERNAL_EFFECTS, INTERNAL_EFFECTS, loadPlan } from '../../src/engine/plan-load.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    removeTmpDir(dir)
  }
  tmpDirs = []
})

interface WritePlanDirOptions {
  permitted_effects?: any
}

function writePlanDir(options: WritePlanDirOptions = {}): { dir: string; planPath: string } {
  const dir = makeTmpDir('authz-test-')
  tmpDirs.push(dir)

  const plan = {
    format_version: 2,
    id: 'plan-1',
    mission_id: 'mission-1',
    immutable_digest: '0123456789abcdef',
    authorization: {
      autonomy: 'safe',
      permitted_effects: options.permitted_effects !== undefined ? options.permitted_effects : [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['ADE-T1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 1,
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }

  const defaultContract = {
    format_version: 2,
    id: 'ADE-T1',
    title: 'Test Story',
    complexity: 'bounded',
    task: 'Test task',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: [],
    },
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN x THE SYSTEM SHALL y.',
      },
    ],
    scenarios: [
      {
        id: 'C1',
        given: 'initial',
        when: 'act',
        then: 'check',
        verifiers: ['E1'],
        evals: ['E1'],
      },
    ],
    verifiers: [
      {
        id: 'E1',
        format_version: 1,
        kind: 'script',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    evals: [
      {
        format_version: 1,
        kind: 'script',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    skills: [],
    roles: {
      maker: {
        family: 'claude',
        model_id: 'claude-sonnet-5',
      },
      checker_round: {
        family: 'codex',
        model_id: 'codex-1',
      },
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 2,
    },
  }

  const planPath = path.join(dir, 'plan.json')
  writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8')

  const storiesDir = path.join(dir, 'stories')
  mkdirSync(storiesDir, { recursive: true })
  writeFileSync(path.join(storiesDir, 'ADE-T1.json'), JSON.stringify(defaultContract, null, 2), 'utf8')

  return { dir, planPath }
}

describe('authorization and permitted_effects parity', () => {
  // CA2 & CA3: local_write: false (forma mapa) é recusado na validação de schema, e ['local_write'] (forma array) é recusado como classe interna
  test('local_write_false_is_refused_before_any_dispatch', () => {
    // Forma mapa: permitted_effects: { local_write: false }
    const { planPath: mapPlan } = writePlanDir({
      permitted_effects: { local_write: false },
    })
    try {
      loadPlan(mapPlan)
      expect.unreachable('deveria ter recusado forma mapa de permitted_effects')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_schema_invalid')
      expect(err.exitCode).toBe(4)
    }

    // Forma array: permitted_effects: ['local_write']
    const { planPath: arrayPlan } = writePlanDir({
      permitted_effects: ['local_write'],
    })
    try {
      loadPlan(arrayPlan)
      expect.unreachable('deveria ter recusado classe interna em permitted_effects')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('internal_effect_declared')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('classe interna não pode ser declarada em permitted_effects: local_write')
    }
  })

  // CA2: Valores não-booleanos ou qualquer forma mapa como { push: 'yes' } são recusados pelo schema do plano
  test('non_boolean_optional_effects_are_refused', () => {
    const { planPath } = writePlanDir({
      permitted_effects: { push: 'yes' },
    })
    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter recusado permitted_effects não array')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('plan_schema_invalid')
      expect(err.exitCode).toBe(4)
    }
  })

  // CA3: Qualquer classe interna declarada em permitted_effects é recusada
  test('internal_effect_declared', () => {
    for (const effect of INTERNAL_EFFECTS) {
      const { planPath } = writePlanDir({
        permitted_effects: [effect],
      })
      try {
        loadPlan(planPath)
        expect.unreachable(`deveria ter recusado classe interna: ${effect}`)
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdeError)
        expect(err.code).toBe('internal_effect_declared')
        expect(err.exitCode).toBe(4)
        expect(err.message).toContain(`classe interna não pode ser declarada em permitted_effects: ${effect}`)
      }
    }
  })

  // CA3: Efeito desconhecido (fora de EXTERNAL_EFFECTS) é recusado com unknown_effect
  test('unknown_effect_is_refused', () => {
    const { planPath } = writePlanDir({
      permitted_effects: ['deploy'],
    })
    try {
      loadPlan(planPath)
      expect.unreachable('deveria ter recusado efeito desconhecido: deploy')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('unknown_effect')
      expect(err.exitCode).toBe(4)
      expect(err.message).toContain('efeito desconhecido: deploy')
    }
  })

  // Efeitos externos válidos são aceitos
  test('valid_external_effects_are_accepted', () => {
    const { planPath } = writePlanDir({
      permitted_effects: EXTERNAL_EFFECTS,
    })
    const result = loadPlan(planPath)
    expect(result.plan.authorization.permitted_effects).toEqual(EXTERNAL_EFFECTS)
  })
})
