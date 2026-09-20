import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { loadPlan } from '../src/engine/plan-load.js'
import { validateSupported } from '../src/schema/index.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

describe('example and dogfood plans', () => {
  // CA1: Dado os três planos, quando loadPlan lê cada um, então nenhum lança e as stories são exatamente ['TEMPLATE-1'], ['SKIN-1'] e ['ADE-D1']
  test('example_plans_load_with_one_story_each', () => {
    const templatePlan = loadPlan(path.join(ROOT, 'examples/plan-template.json'), { mode: 'read' })
    expect(templatePlan.stories.map((s) => s.id)).toEqual(['TEMPLATE-1'])

    const skinPlan = loadPlan(path.join(ROOT, 'examples/skin-sniper/plan.json'), { mode: 'read' })
    expect(skinPlan.stories.map((s) => s.id)).toEqual(['SKIN-1'])

    const dogfoodPlan = loadPlan(path.join(ROOT, 'plans/dogfood/journal-event-field.plan.json'), { mode: 'read' })
    expect(dogfoodPlan.stories.map((s) => s.id)).toEqual(['ADE-D1'])
  })

  // CA2: Dado os três plan.json, quando validateSupported('plan', json) roda em modo de leitura, então valid é true para os três, e a task do contrato SKIN-1 começa com 'TROQUE:'
  test('example_plans_validate_against_plan_schema', () => {
    const templateRaw = JSON.parse(readFileSync(path.join(ROOT, 'examples/plan-template.json'), 'utf8'))
    expect(validateSupported('plan', templateRaw).valid).toBe(true)

    const skinRaw = JSON.parse(readFileSync(path.join(ROOT, 'examples/skin-sniper/plan.json'), 'utf8'))
    expect(validateSupported('plan', skinRaw).valid).toBe(true)

    const dogfoodRaw = JSON.parse(readFileSync(path.join(ROOT, 'plans/dogfood/journal-event-field.plan.json'), 'utf8'))
    expect(validateSupported('plan', dogfoodRaw).valid).toBe(true)

    const skinStory = JSON.parse(readFileSync(path.join(ROOT, 'examples/skin-sniper/stories/SKIN-1.json'), 'utf8'))
    expect(skinStory.task.startsWith('TROQUE:')).toBe(true)
  })

  // CA3: Dado o repositório no estado atual ou depois do dogfood, quando node plans/dogfood/check-attempt.mjs roda,
  // então stdout é um JSON com numTotalTests: 3 e o código de saída é 0 se numPassedTests === 3, senão 1
  test('dogfood_check_reports_three_tests_consistently', () => {
    const result = spawnSync(process.execPath, ['plans/dogfood/check-attempt.mjs'], {
      cwd: ROOT,
      timeout: 30_000,
      encoding: 'utf8',
      maxBuffer: 1_048_576,
    })
    const summary = JSON.parse(result.stdout)
    expect(summary.numTotalTests).toBe(3)
    expect(summary.numPassedTests + summary.numFailedTests).toBe(3)
    expect(result.status).toBe(summary.numPassedTests === 3 ? 0 : 1)
  }, 30_000)
})
