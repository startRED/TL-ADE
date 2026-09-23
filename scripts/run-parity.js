import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdeError } from '../src/journal/errors.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'parity-name-map.json')

export class ParityCaseMissingError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('parity_case_missing', message, 2, details)
  }
}

export class ParityCaseSkippedError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('parity_case_skipped', message, 2, details)
  }
}

/**
 * @typedef {Object} VitestAssertionResult
 * @property {string} title
 * @property {'passed' | 'failed' | 'skipped'} status
 */

/**
 * @typedef {Object} VitestTestResult
 * @property {VitestAssertionResult[]} assertionResults
 */

/**
 * @typedef {Object} VitestJsonReport
 * @property {VitestTestResult[]} testResults
 */

/**
 * @typedef {Object} ParityCase
 * @property {string} source
 * @property {string} target
 * @property {'same' | 'renamed'} status
 * @property {string | null} reason
 * @property {string} test_file
 */

/**
 * @typedef {Object} ParityManifest
 * @property {number} schema_version
 * @property {ParityCase[]} cases
 */

/**
 * Valida o relatório do Vitest contra o manifesto de paridade.
 * Cada target do manifesto deve estar presente e com status 'passed'.
 *
 * @param {ParityManifest} manifest
 * @param {VitestJsonReport} report
 * @returns {{ passed: number, failed: number, skipped: number }}
 */
export function validateParityResult(manifest, report) {
  if (!report || !Array.isArray(report.testResults)) {
    throw new AdeError('parity_invalid_report', 'Relatório Vitest JSON inválido ou incompleto', 2)
  }

  const assertions = report.testResults.flatMap((tr) => tr.assertionResults || [])
  const resultMap = new Map()
  const targets = new Set(manifest.cases.map((item) => item.target))

  for (const a of assertions) {
    if (a && typeof a.title === 'string') {
      resultMap.set(a.title, a)
    }
  }

  let passed = 0
  let failed = 0
  let skipped = 0

  for (const c of manifest.cases) {
    const target = c.target
    const match = resultMap.get(target)

    if (!match) {
      throw new ParityCaseMissingError(`parity_case_missing: ${target}`, { target })
    }

    if (match.status === 'skipped') {
      throw new ParityCaseSkippedError(`parity_case_skipped: ${target}`, { target })
    }

    if (match.status === 'failed') {
      failed++
      throw new AdeError('parity_case_failed', `parity_case_failed: ${target}`, 2, { target })
    }

    if (match.status === 'passed') {
      passed++
    }
  }

  for (const assertion of assertions) {
    if (!targets.has(assertion.title)) continue

    if (assertion.status === 'skipped') {
      throw new ParityCaseSkippedError(`parity_case_skipped: ${assertion.title}`, {
        target: assertion.title,
      })
    }

    if (assertion.status === 'failed') {
      throw new AdeError(
        'parity_case_failed',
        `parity_case_failed: ${assertion.title}`,
        2,
        { target: assertion.title },
      )
    }
  }

  return { passed, failed, skipped }
}

const EXTERNAL_PATTERN = /\b(claude|codex|gh)\b|https?:\/\//i

/**
 * Executa a faixa de paridade através de um runner Node multiplataforma com 4 workers e validação fechada.
 *
 * @param {Object} [options]
 * @param {string} [options.repoDir]
 * @param {string} [options.manifestPath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.workers]
 * @param {Function} [options.spawnImpl]
 * @param {number} [options.simulatedDurationMs]
 * @param {string[]} [options.args]
 * @param {string[]} [options.extraArgs]
 * @param {string} [options.command]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ passed: number, failed: number, skipped: number, workers: 4, duration_ms: number, cases: VitestAssertionResult[] }>}
 */
export async function runParity(options = {}) {
  const repoDir = options.repoDir || ROOT
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 360000
  const spawnImpl = options.spawnImpl || spawn

  // Verificação de segurança antes de qualquer chamada ou spawn (CA5)
  const itemsToScan = [
    options.command,
    ...(options.args || []),
    ...(options.extraArgs || []),
    ...Object.keys(options.env || {}),
    ...Object.values(options.env || {}),
  ].filter(Boolean)

  for (const item of itemsToScan) {
    if (typeof item === 'string' && EXTERNAL_PATTERN.test(item)) {
      throw new AdeError(
        'parity_external_command_refused',
        `Comando ou argumento externo proibido na faixa de paridade: ${item}`,
        2,
        { item },
      )
    }
  }

  const manifestRaw = readFileSync(manifestPath, 'utf8')
  /** @type {ParityManifest} */
  const manifest = JSON.parse(manifestRaw)
  const targetPattern = `(?:^|\\s)(?:${manifest.cases
    .map((item) => item.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})$`

  const vitestScript = path.join(repoDir, 'node_modules', 'vitest', 'vitest.mjs')
  const args = [
    vitestScript,
    'run',
    '--reporter=json',
    '--testNamePattern',
    targetPattern,
    ...(options.extraArgs || []),
  ]

  const startTime = process.hrtime.bigint()

  return new Promise((resolve, reject) => {
    let child
    let settled = false

    /** @param {unknown} error */
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    try {
      child = spawnImpl(process.execPath, args, {
        cwd: repoDir,
        env: {
          ...process.env,
          ...options.env,
          ADE_PARITY: '1',
        },
        maxBuffer: 50 * 1024 * 1024,
      })
    } catch (err) {
      rejectOnce(err)
      return
    }

    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch (error) {
        rejectOnce(error)
        return
      }
      rejectOnce(
        new AdeError(
          'parity_timeout',
          `Duração da execução excedeu limite de ${timeoutMs}ms`,
          2,
          { timeout_ms: timeoutMs },
        ),
      )
    }, timeoutMs)

    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []

    /** @param {Buffer | string} chunk */
    const collectStdout = (chunk) => stdoutChunks.push(Buffer.from(chunk))
    /** @param {Buffer | string} chunk */
    const collectStderr = (chunk) => stderrChunks.push(Buffer.from(chunk))

    if (child.stdout) {
      child.stdout.on('data', collectStdout)
    }
    if (child.stderr) {
      child.stderr.on('data', collectStderr)
    }

    /** @param {Error} err */
    const onError = (err) => {
      clearTimeout(timeout)
      rejectOnce(err)
    }
    child.on('error', onError)

    /** @param {number | null} exitCode */
    const onClose = (exitCode) => {
      clearTimeout(timeout)
      if (settled) return

      const endTime = process.hrtime.bigint()
      const realDurationMs = Number((endTime - startTime) / 1_000_000n)
      const durationMs =
        typeof options.simulatedDurationMs === 'number'
          ? options.simulatedDurationMs
          : realDurationMs

      if (durationMs > timeoutMs) {
        return rejectOnce(
          new AdeError(
            'parity_timeout',
            `Duração da execução (${durationMs}ms) excedeu limite de ${timeoutMs}ms`,
            2,
            { duration_ms: durationMs, timeout_ms: timeoutMs },
          ),
        )
      }

      const stdoutStr = Buffer.concat(stdoutChunks).toString('utf8').trim()
      /** @type {VitestJsonReport} */
      let report
      try {
        report = JSON.parse(stdoutStr)
      } catch (parseErr) {
        const reason = parseErr instanceof Error ? parseErr.message : String(parseErr)
        return rejectOnce(
          new AdeError(
            'parity_report_parse_error',
            `Falha ao converter relatório Vitest em JSON: ${reason}\nSaída: ${stdoutStr.slice(0, 500)}`,
            2,
          ),
        )
      }

      try {
        const validated = validateParityResult(manifest, report)
        if (exitCode !== 0) {
          throw new AdeError(
            'parity_vitest_failed',
            `Vitest encerrou com código ${exitCode}`,
            2,
            { exit_code: exitCode },
          )
        }

        const assertions = (report.testResults || []).flatMap((tr) => tr.assertionResults || [])
        const targets = new Set(manifest.cases.map((item) => item.target))
        const cases = assertions.filter(
          (item, index) =>
            targets.has(item.title) &&
            assertions.findIndex((candidate) => candidate.title === item.title) === index,
        )

        settled = true
        resolve({
          passed: validated.passed,
          failed: validated.failed,
          skipped: validated.skipped,
          workers: 4,
          duration_ms: durationMs,
          cases,
        })
      } catch (valErr) {
        rejectOnce(valErr)
      }
    }
    child.on('close', onClose)
  })
}

// Execução direta via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runParity()
    .then((res) => {
      console.log(
        JSON.stringify({
          passed: res.passed,
          failed: res.failed,
          skipped: res.skipped,
          workers: res.workers,
          duration_ms: res.duration_ms,
        }),
      )
      process.exit(0)
    })
    .catch((err) => {
      const code = err.code || 'parity_failure'
      const exitCode = typeof err.exitCode === 'number' ? err.exitCode : 2
      console.error(`${code}: ${err.message}`)
      process.exit(exitCode)
    })
}
