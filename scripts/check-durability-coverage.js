import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { AdeError } from '../src/journal/errors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * Lista normativa dos seis módulos duráveis.
 */
export const coverageModules = [
  'journal',
  'step',
  'lease',
  'git',
  'runner',
  'contain',
]

/**
 * Lista normativa de testes do portão de cobertura durável.
 */
export const normativeTestPaths = [
  'tests/parity/',
  'tests/journal.test.ts',
  'tests/step.test.ts',
  'tests/lease.test.ts',
  'tests/contain.test.ts',
  'tests/receipt.test.ts',
  'tests/reconcile.test.ts',
]

export const NORMATIVE_TEST_PATHS = normativeTestPaths

/**
 * Valida que a seleção de testes não inclui probes proibidas.
 *
 * @param {string[]} testPaths
 * @returns {string[]}
 */
export function assertCoverageSelection(testPaths) {
  if (!Array.isArray(testPaths)) {
    throw new AdeError('coverage_invalid_selection', 'seleção de testes deve ser uma lista', 2)
  }
  const probeRegex = /(?:^|[\\/])tests[\\/]probes[\\/]/
  for (const p of testPaths) {
    if (typeof p !== 'string' || probeRegex.test(p) || p.includes('tests/probes/') || p.includes('tests\\probes\\')) {
      throw new AdeError(
        'coverage_invalid_selection',
        `seleção de testes inválida: ${p} sob tests/probes/`,
        2,
        { path: p },
      )
    }
  }
  return testPaths
}

/**
 * Agrega a cobertura de linhas por módulo a partir do resumo do Vitest (coverage-summary.json).
 *
 * @param {Record<string, unknown>} summary
 * @returns {Record<string, number>}
 */
export function summarizeDurabilityCoverage(summary) {
  /** @type {Record<string, number>} */
  const result = {
    journal: 0,
    step: 0,
    lease: 0,
    git: 0,
    runner: 0,
    contain: 0,
  }

  if (!summary || typeof summary !== 'object') {
    return result
  }

  for (const mod of coverageModules) {
    let coveredSum = 0
    let totalSum = 0
    let fileCount = 0
    const regex = new RegExp(`(?:^|[\\\\/])src[\\\\/]${mod}[\\\\/]`)

    for (const [key, fileData] of Object.entries(summary)) {
      if (key === 'total') continue
      if (regex.test(key)) {
        fileCount++
        if (fileData && typeof fileData === 'object' && 'lines' in fileData) {
          const lines = /** @type {{ total?: number, covered?: number }} */ (fileData.lines)
          coveredSum += Number(lines.covered) || 0
          totalSum += Number(lines.total) || 0
        }
      }
    }

    if (fileCount > 0 && totalSum > 0) {
      result[mod] = (100 * coveredSum) / totalSum
    } else {
      result[mod] = 0
    }
  }

  return result
}

/**
 * Verifica se todos os módulos atingiram o limite normativo de 85%.
 *
 * @param {Record<string, number>} percentages
 * @returns {Record<string, number>}
 */
export function assertDurabilityCoverage(percentages) {
  /** @type {Record<string, number>} */
  const modules = {}
  let belowThreshold = false

  for (const mod of coverageModules) {
    const raw = percentages && typeof percentages === 'object' ? percentages[mod] : undefined
    const pct = typeof raw === 'number' ? raw : 0
    modules[mod] = pct
    if (!Number.isFinite(pct) || pct < 85) {
      belowThreshold = true
    }
  }

  if (belowThreshold) {
    throw new AdeError(
      'coverage_below_threshold',
      'cobertura abaixo do limite normativo de 85%',
      2,
      { modules },
    )
  }

  return percentages
}

/**
 * Lê coverage/coverage-summary.json e executa as verificações normativas.
 *
 * @param {string} [summaryPath]
 * @returns {Record<string, number>}
 */
export function checkDurabilityCoverage(summaryPath) {
  assertCoverageSelection(normativeTestPaths)

  const resolvedPath = summaryPath ?? path.resolve(ROOT, 'coverage', 'coverage-summary.json')
  if (!existsSync(resolvedPath)) {
    throw new AdeError(
      'coverage_summary_missing',
      `resumo de cobertura não encontrado: ${resolvedPath}`,
      2,
      { path: resolvedPath },
    )
  }

  let summary
  try {
    summary = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  } catch (err) {
    throw new AdeError(
      'coverage_summary_corrupt',
      `resumo de cobertura ilegível: ${err instanceof Error ? err.message : String(err)}`,
      2,
      { path: resolvedPath },
    )
  }

  const aggregated = summarizeDurabilityCoverage(summary)
  return assertDurabilityCoverage(aggregated)
}

// Execução direta via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const approved = checkDurabilityCoverage()
    console.log(JSON.stringify(approved))
    process.exit(0)
  } catch (err) {
    if (err instanceof AdeError) {
      console.error(`Erro de cobertura: ${err.message}`)
      process.exit(err.exitCode)
    }
    console.error(err instanceof Error ? `Erro de cobertura: ${err.message}` : String(err))
    process.exit(2)
  }
}
