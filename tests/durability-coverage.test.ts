import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'
import {
  assertCoverageSelection,
  assertDurabilityCoverage,
  coverageModules,
  normativeTestPaths,
  summarizeDurabilityCoverage,
} from '../scripts/check-durability-coverage.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

describe('portão de cobertura durável', () => {
  // CA1 — Dado o comando npm run test:durability-coverage no projeto com s1,
  // quando todos os testes terminarem, então ele sai 0 somente se journal, step,
  // lease, git, runner e contain tiverem ao menos 85% de linhas.
  test('ca1_durability_coverage_passes_when_all_modules_reach_85_percent_and_manifest_matches', () => {
    expect(coverageModules).toEqual(['journal', 'step', 'lease', 'git', 'runner', 'contain'])

    // Agregação por diretório com separadores POSIX (/) e Windows (\)
    const summary = {
      'src/journal/events.js': { lines: { total: 100, covered: 90, skipped: 0, pct: 90 } },
      'C:\\project\\src\\journal\\journal.js': { lines: { total: 100, covered: 80, skipped: 0, pct: 80 } },
      'src/step/step.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'D:\\workspace\\src\\lease\\lease.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/git/git.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/runner/runner.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src\\contain\\contain.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
    }

    const aggregated = summarizeDurabilityCoverage(summary)
    expect(aggregated).toEqual({
      journal: 85,
      step: 85,
      lease: 85,
      git: 85,
      runner: 85,
      contain: 85,
    })

    // Limite exato de 85% passa e devolve o próprio objeto
    const exactInput = { journal: 85, step: 85, lease: 85, git: 85, runner: 85, contain: 85 }
    const result = assertDurabilityCoverage(exactInput)
    expect(result).toBe(exactInput)

    // Conferir o script test:durability-coverage no manifesto (package.json)
    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const script = pkg.scripts?.['test:durability-coverage']
    expect(script).toBeDefined()
    expect(script).toContain('vitest.mjs run')
    expect(script).toContain('--coverage.enabled=true')
    expect(script).toContain('--coverage.reporter=json-summary')
    expect(script).toContain('--coverage.reportsDirectory=coverage')
    expect(script).toContain('node scripts/check-durability-coverage.js')

    // Provar que a seleção literal no script contém os caminhos normativos
    for (const testPath of normativeTestPaths) {
      expect(script).toContain(testPath)
    }
  })

  // CA2 — Dado um resumo sem o módulo lease, quando o verificador agregar a cobertura,
  // então lease vale 0 e ocorre coverage_below_threshold com exitCode:2.
  test('ca2_durability_coverage_missing_module_evaluates_to_zero_and_throws_exit_code_2', () => {
    // Resumo sem o módulo lease
    const summaryWithoutLease = {
      'src/journal/events.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/step/step.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/git/git.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/runner/runner.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      'src/contain/contain.js': { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
    }

    const aggregated = summarizeDurabilityCoverage(summaryWithoutLease)
    expect(aggregated.lease).toBe(0)

    // assertDurabilityCoverage({journal:85,step:85,git:85,runner:85,contain:85}) sem lease
    let thrownError: unknown = null
    try {
      assertDurabilityCoverage({
        journal: 85,
        step: 85,
        git: 85,
        runner: 85,
        contain: 85,
      })
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(AdeError)
    const adeErr = thrownError as AdeError
    expect(adeErr.code).toBe('coverage_below_threshold')
    expect(adeErr.exitCode).toBe(2)
    expect(adeErr.details).toBeDefined()
    const detailsModules = adeErr.details?.modules as Record<string, number>
    expect(detailsModules.lease).toBe(0)
  })

  // CA3 — Dado runner com 84,99% e os outros cinco módulos com 85%, quando o limite
  // for verificado, então ocorre coverage_below_threshold com exitCode:2 e os detalhes
  // preservam runner:84.99.
  test('ca3_durability_coverage_below_threshold_preserves_exact_percentage_and_throws_exit_code_2', () => {
    let thrownError: unknown = null
    try {
      assertDurabilityCoverage({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 84.99,
        contain: 85,
      })
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(AdeError)
    const adeErr = thrownError as AdeError
    expect(adeErr.code).toBe('coverage_below_threshold')
    expect(adeErr.exitCode).toBe(2)
    expect(adeErr.details).toBeDefined()
    const detailsModules = adeErr.details?.modules as Record<string, number>
    expect(detailsModules.runner).toBe(84.99)
  })

  test('ca1_durability_coverage_rejects_non_finite_and_non_numeric_values', () => {
    // NaN
    let thrownNan: unknown = null
    try {
      assertDurabilityCoverage({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: NaN,
        contain: 85,
      })
    } catch (err) {
      thrownNan = err
    }
    expect(thrownNan).toBeInstanceOf(AdeError)
    const nanErr = thrownNan as AdeError
    expect(nanErr.code).toBe('coverage_below_threshold')
    expect(nanErr.exitCode).toBe(2)
    const nanModules = nanErr.details?.modules as Record<string, number> | undefined
    expect(Number.isNaN(nanModules?.runner)).toBe(true)

    // Infinity
    let thrownInf: unknown = null
    try {
      assertDurabilityCoverage({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: Infinity,
        contain: 85,
      })
    } catch (err) {
      thrownInf = err
    }
    expect(thrownInf).toBeInstanceOf(AdeError)
    const infErr = thrownInf as AdeError
    expect(infErr.code).toBe('coverage_below_threshold')
    expect(infErr.exitCode).toBe(2)
    const infModules = infErr.details?.modules as Record<string, number> | undefined
    expect(infModules?.runner).toBe(Infinity)

    // Non-numeric
    let thrownStr: unknown = null
    try {
      assertDurabilityCoverage({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: '85' as unknown as number,
        contain: 85,
      })
    } catch (err) {
      thrownStr = err
    }
    expect(thrownStr).toBeInstanceOf(AdeError)
    const strErr = thrownStr as AdeError
    expect(strErr.code).toBe('coverage_below_threshold')
    expect(strErr.exitCode).toBe(2)
    const strModules = strErr.details?.modules as Record<string, number> | undefined
    expect(strModules?.runner).toBe(0)
  })

  // CA4 — Dada uma seleção contendo tests/probes/e2e.test.ts, quando a seleção for
  // validada, então ocorre coverage_invalid_selection com exitCode:2; a seleção
  // normativa não contém probes.
  test('ca4_assert_coverage_selection_rejects_probes_and_accepts_normative_paths', () => {
    // Probes proibidas
    let thrownError: unknown = null
    try {
      assertCoverageSelection(['tests/probes/e2e.test.ts'])
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(AdeError)
    const adeErr = thrownError as AdeError
    expect(adeErr.code).toBe('coverage_invalid_selection')
    expect(adeErr.exitCode).toBe(2)

    // Seleção normativa não contém probes
    for (const testPath of normativeTestPaths) {
      expect(testPath).not.toContain('tests/probes/')
    }
    const validated = assertCoverageSelection(normativeTestPaths)
    expect(validated).toBe(normativeTestPaths)
  })

  // CA5 — Dado coverage/coverage-summary.json gerado na raiz, quando o guardião e o
  // estado Git forem consultados, então o teste de raiz passa e coverage/ não aparece
  // como alteração versionável.
  test('ca5_coverage_directory_is_in_allowlist_and_ignored_by_git', () => {
    const gitignoreContent = readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    expect(gitignoreContent).toMatch(/^coverage\/?$/m)

    const metaTestContent = readFileSync(path.join(ROOT, 'tests/meta.test.ts'), 'utf8')
    expect(metaTestContent).toContain("'coverage'")
  })
})
