/**
 * @typedef {Object} ReporterReport
 * @property {number} numTotalTests
 * @property {number} numPassedTests
 * @property {number} numFailedTests
 */

/**
 * Lê o objeto do reporter JSON do Vitest tolerando lixo antes e depois.
 *
 * @param {string} stdout
 * @returns {ReporterReport | null}
 */
export function parseReporterJson(stdout) {
  if (typeof stdout !== 'string') {
    return null
  }

  const first = stdout.indexOf('{')
  const last = stdout.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) {
    return null
  }

  const slice = stdout.slice(first, last + 1)
  let parsed
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.numTotalTests !== 'number' ||
    Number.isNaN(parsed.numTotalTests) ||
    typeof parsed.numPassedTests !== 'number' ||
    Number.isNaN(parsed.numPassedTests) ||
    typeof parsed.numFailedTests !== 'number' ||
    Number.isNaN(parsed.numFailedTests)
  ) {
    return null
  }

  return {
    numTotalTests: parsed.numTotalTests,
    numPassedTests: parsed.numPassedTests,
    numFailedTests: parsed.numFailedTests,
  }
}

/**
 * @typedef {Object} ClassifyRedParams
 * @property {number | null} exitCode
 * @property {number} expectExit
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {ReporterReport | null} report
 */

/**
 * @typedef {Object} ClassifyRedResult
 * @property {'assertion' | 'missing_target' | 'compile_error' | 'environment' | null} red_reason
 * @property {number | null} num_total_tests
 */

/**
 * Regex para identificação de erros de compilação/módulo/sintaxe.
 */
const COMPILE_ERROR_REGEX = /SyntaxError|Transform failed|Failed to load|Cannot find module|TS\d{4}:/

/**
 * Classifica a causa da falha na fase vermelha do eval seguindo ordem de precedência fixa.
 *
 * @param {ClassifyRedParams} params
 * @returns {ClassifyRedResult}
 */
export function classifyRed({ exitCode, expectExit, timedOut, stdout, stderr, report }) {
  const isReportValid =
    report !== null &&
    typeof report === 'object' &&
    !Array.isArray(report) &&
    typeof report.numTotalTests === 'number' &&
    !Number.isNaN(report.numTotalTests) &&
    typeof report.numPassedTests === 'number' &&
    !Number.isNaN(report.numPassedTests) &&
    typeof report.numFailedTests === 'number' &&
    !Number.isNaN(report.numFailedTests)

  const num_total_tests = isReportValid ? report.numTotalTests : null

  const combinedOutput = (stderr ?? '') + '\n' + (stdout ?? '')

  /** @type {'assertion' | 'missing_target' | 'compile_error' | 'environment' | null} */
  let red_reason
  if (timedOut) {
    red_reason = 'environment'
  } else if (!isReportValid) {
    red_reason = 'environment'
  } else if (report.numTotalTests === 0) {
    red_reason = 'missing_target'
  } else if (COMPILE_ERROR_REGEX.test(combinedOutput)) {
    red_reason = 'compile_error'
  } else if (report.numFailedTests >= 1) {
    red_reason = 'assertion'
  } else if (exitCode === expectExit) {
    red_reason = null
  } else {
    red_reason = 'environment'
  }

  return {
    red_reason,
    num_total_tests,
  }
}
