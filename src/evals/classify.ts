interface ReporterReport {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests?: number
  numTodoTests?: number
}

/**
 * Lê o objeto do reporter JSON do Vitest tolerando lixo antes e depois.
 */
export function parseReporterJson(stdout: string): ReporterReport | null {
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

  if (
    'numPendingTests' in parsed &&
    (typeof parsed.numPendingTests !== 'number' || Number.isNaN(parsed.numPendingTests))
  ) {
    return null
  }
  if (
    'numTodoTests' in parsed &&
    (typeof parsed.numTodoTests !== 'number' || Number.isNaN(parsed.numTodoTests))
  ) {
    return null
  }

  
  const result: ReporterReport = {
    numTotalTests: parsed.numTotalTests,
    numPassedTests: parsed.numPassedTests,
    numFailedTests: parsed.numFailedTests,
  }

  if ('numPendingTests' in parsed) {
    result.numPendingTests = parsed.numPendingTests
  }
  if ('numTodoTests' in parsed) {
    result.numTodoTests = parsed.numTodoTests
  }

  return result
}

interface ClassifyRedParams {
  exitCode: number | null
  expectExit: number
  timedOut: boolean
  stdout: string
  stderr: string
  report: ReporterReport | null
}

interface ClassifyRedResult {
  red_reason: 'assertion' | 'missing_target' | 'compile_error' | 'environment' | null
  num_total_tests: number | null
}

/**
 * Regex para identificação de erros de compilação/módulo/sintaxe.
 */
const COMPILE_ERROR_REGEX = /SyntaxError|Transform failed|Failed to load|Cannot find module|TS\d{4}:/

/**
 * Classifica a causa da falha na fase vermelha do eval seguindo ordem de precedência fixa.
 */
export function classifyRed({ exitCode, expectExit, timedOut, stdout, stderr, report }: ClassifyRedParams): ClassifyRedResult {
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

  const skipped = isReportValid ? (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0) : 0
  const executed = isReportValid ? Math.max(0, report.numTotalTests - skipped) : null
  const num_total_tests = executed

  const combinedOutput = (stderr ?? '') + '\n' + (stdout ?? '')

  
  let red_reason: 'assertion' | 'missing_target' | 'compile_error' | 'environment' | null
  if (timedOut) {
    red_reason = 'environment'
  } else if (!isReportValid) {
    red_reason = 'environment'
  } else if (executed === 0) {
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

interface ClassifyGreenParams {
  red_reason: 'assertion' | 'missing_target' | 'compile_error' | 'environment' | null
}

interface ClassifyGreenResult {
  verdict: 'green' | 'green_failed' | 'refused'
  warnings: string[]
}

/**
 * Classifica o resultado da fase verde a partir do red_reason produzido por classifyRed:
 * sem motivo é verde; alvo ausente (zero teste executado) é recusado, nunca verde (E58);
 * qualquer outro motivo é falha verde.
 */
export function classifyGreen({ red_reason }: ClassifyGreenParams): ClassifyGreenResult {
  if (red_reason === null) {
    return { verdict: 'green', warnings: [] }
  }
  if (red_reason === 'missing_target') {
    return { verdict: 'refused', warnings: ['green_missing_target'] }
  }
  return { verdict: 'green_failed', warnings: [`red_reason=${red_reason}`] }
}
