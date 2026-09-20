import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CRASH_MATRIX_CELLS, validateEvidence } from '../src/evidence/slice1.js'
import { AdeError } from '../src/journal/errors.js'
import { runParity as defaultRunParity } from './run-parity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const HASH_REGEX = /^[0-9a-f]{40}$/

/**
 * Executa comandos Git com buffer explícito, sem shell e cwd configurável.
 *
 * @param {string[]} args
 * @param {Object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxBuffer]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function defaultRunGit(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd || ROOT,
    shell: false,
    maxBuffer: opts.maxBuffer || 52428800,
    encoding: 'utf8',
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  }
}

/**
 * Coletor operacional para registrar evidência executada no Windows.
 *
 * @param {Object} [options]
 * @param {string} [options.repoDir]
 * @param {string} [options.outputPath]
 * @param {string} [options.platform]
 * @param {string} [options.nodeVersion]
 * @param {Function} [options.runParity]
 * @param {Function} [options.runCrashMatrix]
 * @param {Function} [options.runCoverage]
 * @param {Function} [options.runGit]
 * @param {Function} [options.now]
 * @returns {Promise<import('../src/evidence/slice1.js').EvidenceV1>}
 */
export async function recordSlice1Evidence(options = {}) {
  const repoDir = options.repoDir ? path.resolve(options.repoDir) : ROOT
  const outputPath = options.outputPath || path.join(repoDir, 'docs', 'operations', 'slice-1-windows.json')
  const resolvedOutputPath = path.resolve(repoDir, outputPath)
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.version
  const runGit = options.runGit || defaultRunGit
  const runParityImpl = options.runParity || defaultRunParity

  // 1. Exigir plataforma win32
  if (platform !== 'win32') {
    throw new AdeError(
      'slice1_evidence_invalid',
      `Plataforma incompatível: esperada 'win32', recebida '${platform}'`,
      2,
      { platform },
    )
  }

  try {
    // 2. Obter commit e árvore Git
    const commitRes = runGit(['rev-parse', 'HEAD'], { cwd: repoDir, maxBuffer: 52428800 })
    if (commitRes.status !== 0) {
      throw new AdeError(
        'slice1_evidence_invalid',
        `Falha ao obter commit HEAD: ${commitRes.stderr.trim()}`,
        2,
      )
    }
    const commit = commitRes.stdout.trim()

    const treeRes = runGit(['rev-parse', 'HEAD^{tree}'], { cwd: repoDir, maxBuffer: 52428800 })
    if (treeRes.status !== 0) {
      throw new AdeError(
        'slice1_evidence_invalid',
        `Falha ao obter tree HEAD: ${treeRes.stderr.trim()}`,
        2,
      )
    }
    const tree = treeRes.stdout.trim()

    if (!HASH_REGEX.test(commit) || !HASH_REGEX.test(tree)) {
      throw new AdeError(
        'slice1_evidence_invalid',
        `Hashes de commit/tree inválidos (esperado SHA-1 de 40 caracteres minúsculos)`,
        2,
        { commit, tree },
      )
    }

    // 3. Consultar git status --porcelain e verificar limpeza da árvore
    const statusRes = runGit(['status', '--porcelain'], { cwd: repoDir, maxBuffer: 52428800 })
    if (statusRes.status !== 0) {
      throw new AdeError(
        'slice1_evidence_invalid',
        `Falha ao verificar status Git: ${statusRes.stderr.trim()}`,
        2,
      )
    }

    const relOutputPath = path.relative(repoDir, resolvedOutputPath).replace(/\\/g, '/')
    const porcelainLines = statusRes.stdout
      .split('\n')
      .map((/** @type {string} */ line) => line.replace(/\r$/, ''))
      .filter((/** @type {string} */ line) => line.trim())

    for (const line of porcelainLines) {
      // Formato porcelain v1: "XY <caminho>" ou "XY <caminho_antigo> -> <caminho_novo>"
      if (line.length < 4 || line[2] !== ' ') {
        throw new AdeError('slice1_evidence_invalid', `Entrada inválida no status Git: ${line}`, 2)
      }

      const status = line.slice(0, 2)
      let rawPath = line.slice(3).trim()
      if (status.includes('R') || status.includes('C') || rawPath.includes(' -> ')) {
        throw new AdeError(
          'slice1_evidence_invalid',
          `Árvore de trabalho Git possui rename/copy pendente: ${rawPath}`,
          2,
          { dirty_file: rawPath },
        )
      }
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1)
      }
      const normPath = rawPath.replace(/\\/g, '/')
      if (normPath !== relOutputPath) {
        throw new AdeError(
          'slice1_evidence_invalid',
          `Árvore de trabalho Git possui alterações pendentes não ignoradas: ${normPath}`,
          2,
          { dirty_file: normPath },
        )
      }
    }

    // 4. Executar paridade
    const parityResult = await runParityImpl({ repoDir })
    if (!parityResult || typeof parityResult !== 'object') {
      throw new AdeError('slice1_evidence_invalid', 'Resultado de paridade inválido ou ausente', 2)
    }

    // 5. Executar matriz de queda
    let crashPassed = 0
    let crashFailed = 0
    /** @type {Record<string, 'passed' | 'failed'>} */
    const crashCells = {}

    if (options.runCrashMatrix) {
      const crashRaw = await options.runCrashMatrix({ repoDir })
      if (crashRaw && typeof crashRaw === 'object' && 'status' in crashRaw && crashRaw.status !== 0) {
        throw new AdeError('slice1_evidence_invalid', `Execução da crash_matrix encerrou com status ${crashRaw.status}`, 2)
      }
      if (crashRaw && typeof crashRaw === 'object' && 'cells' in crashRaw) {
        crashPassed = Number(crashRaw.passed) || 0
        crashFailed = Number(crashRaw.failed) || 0
        Object.assign(crashCells, crashRaw.cells)
      } else if (crashRaw && typeof crashRaw === 'object' && 'status' in crashRaw) {
        const report = JSON.parse(crashRaw.stdout)
        const assertions = (report.testResults || []).flatMap(
          (/** @type {{ assertionResults?: Array<{ title?: string, status?: string }> }} */ tr) => tr.assertionResults || [],
        )
        for (const cell of CRASH_MATRIX_CELLS) {
          const match = assertions.find((/** @type {{ title?: string }} */ a) => a.title === cell)
          if (match && match.status === 'passed') {
            crashCells[cell] = 'passed'
            crashPassed++
          } else {
            crashCells[cell] = 'failed'
            crashFailed++
          }
        }
      } else {
        throw new AdeError('slice1_evidence_invalid', 'Saída de runCrashMatrix inválida', 2)
      }
    } else {
      const vitestScript = path.join(repoDir, 'node_modules', 'vitest', 'vitest.mjs')
      const crashTest = path.join(repoDir, 'tests', 'parity', 'crash-matrix.test.ts')
      const crashExec = spawnSync(
        process.execPath,
        [vitestScript, 'run', crashTest, '--reporter=json'],
        {
          cwd: repoDir,
          shell: false,
          maxBuffer: 52428800,
          encoding: 'utf8',
        },
      )
      if (crashExec.status !== 0) {
        throw new AdeError(
          'slice1_evidence_invalid',
          `Vitest crash_matrix falhou com código ${crashExec.status}: ${crashExec.stderr.trim()}`,
          2,
        )
      }
      const report = JSON.parse(crashExec.stdout)
      const assertions = (report.testResults || []).flatMap(
        (/** @type {{ assertionResults?: Array<{ title?: string, status?: string }> }} */ tr) => tr.assertionResults || [],
      )
      for (const cell of CRASH_MATRIX_CELLS) {
        const match = assertions.find((/** @type {{ title?: string }} */ a) => a.title === cell)
        if (match && match.status === 'passed') {
          crashCells[cell] = 'passed'
          crashPassed++
        } else {
          crashCells[cell] = 'failed'
          crashFailed++
        }
      }
    }

    // 6. Executar portão de cobertura
    /** @type {Record<string, number>} */
    let coverage = {}

    if (options.runCoverage) {
      const covRaw = await options.runCoverage({ repoDir })
      if (covRaw && typeof covRaw === 'object') {
        if ('status' in covRaw && covRaw.status !== 0) {
          throw new AdeError('slice1_evidence_invalid', `Execução de cobertura encerrou com status ${covRaw.status}`, 2)
        }
        if ('journal' in covRaw) {
          coverage = covRaw
        } else if ('coverage' in covRaw) {
          coverage = covRaw.coverage
        } else if ('status' in covRaw) {
          coverage = JSON.parse(covRaw.stdout)
        }
      }
    } else {
      const vitestScript = path.join(repoDir, 'node_modules', 'vitest', 'vitest.mjs')
      const covArgs = [
        vitestScript,
        'run',
        '--coverage.enabled=true',
        '--coverage.reporter=json-summary',
        '--coverage.reportsDirectory=coverage',
        'tests/parity/',
        'tests/journal.test.ts',
        'tests/step.test.ts',
        'tests/lease.test.ts',
        'tests/contain.test.ts',
        'tests/receipt.test.ts',
        'tests/reconcile.test.ts',
      ]
      const covExec = spawnSync(process.execPath, covArgs, {
        cwd: repoDir,
        shell: false,
        maxBuffer: 52428800,
        encoding: 'utf8',
      })
      if (covExec.status !== 0) {
        throw new AdeError(
          'slice1_evidence_invalid',
          `Vitest coverage encerrou com erro (código ${covExec.status}): ${covExec.stderr.trim()}`,
          2,
        )
      }

      const checkScript = path.join(repoDir, 'scripts', 'check-durability-coverage.js')
      const checkExec = spawnSync(process.execPath, [checkScript], {
        cwd: repoDir,
        shell: false,
        maxBuffer: 52428800,
        encoding: 'utf8',
      })
      if (checkExec.status !== 0) {
        throw new AdeError(
          'slice1_evidence_invalid',
          `check-durability-coverage falhou com código ${checkExec.status}: ${checkExec.stderr.trim()}`,
          2,
        )
      }
      coverage = JSON.parse(checkExec.stdout.trim())
    }

    // 7. Montar EvidenceV1
    const candidateEvidence = {
      schema_version: 1,
      status: 'executed',
      commit,
      tree,
      system: 'windows',
      node_version: nodeVersion,
      workers: 4,
      duration_ms: parityResult.duration_ms,
      parity: {
        passed: parityResult.passed,
        failed: parityResult.failed,
        skipped: parityResult.skipped,
      },
      crash_matrix: {
        passed: crashPassed,
        failed: crashFailed,
        cells: crashCells,
      },
      coverage: {
        journal: coverage.journal,
        step: coverage.step,
        lease: coverage.lease,
        git: coverage.git,
        runner: coverage.runner,
        contain: coverage.contain,
      },
    }

    // 8. Validar evidência pura
    const validated = validateEvidence(candidateEvidence)

    // 9. Gravar atomicamente no destino com temporário irmão
    const targetDir = path.dirname(resolvedOutputPath)
    fs.mkdirSync(targetDir, { recursive: true })
    const tempPath = path.join(
      targetDir,
      `.tmp-${path.basename(resolvedOutputPath)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    )

    let fd = null
    try {
      fd = fs.openSync(tempPath, 'w')
      fs.writeFileSync(fd, JSON.stringify(validated, null, 2) + '\n', 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tempPath, resolvedOutputPath)
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
      }
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath)
        } catch {}
      }
    }

    return validated
  } catch (err) {
    if (err instanceof AdeError && err.code === 'slice1_evidence_invalid') {
      throw err
    }
    throw new AdeError(
      'slice1_evidence_invalid',
      err instanceof Error ? err.message : String(err),
      2,
    )
  }
}

// Execução direta via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  recordSlice1Evidence()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
      process.exit(0)
    })
    .catch((err) => {
      const exitCode = typeof err.exitCode === 'number' ? err.exitCode : 2
      console.error(`${err.code || 'slice1_evidence_invalid'}: ${err.message}`)
      process.exit(exitCode)
    })
}
