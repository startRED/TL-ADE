import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { recordSlice1Evidence } from '../scripts/record-slice1-evidence.js'
import { CRASH_MATRIX_CELLS, validateEvidence } from '../src/evidence/slice1.js'
import { AdeError } from '../src/journal/errors.js'

describe('slice1 evidence', () => {
  const validEvidenceLiteral = {
    schema_version: 1,
    status: 'executed',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    system: 'windows',
    node_version: 'v22.20.0',
    workers: 4,
    duration_ms: 120000,
    parity: {
      passed: 93,
      failed: 0,
      skipped: 0,
    },
    crash_matrix: {
      passed: 12,
      failed: 0,
      cells: {
        engine_before_spawn: 'passed',
        worker_before_spawn: 'passed',
        engine_after_maker_effect: 'passed',
        worker_after_maker_effect: 'passed',
        engine_before_contain: 'passed',
        worker_before_contain: 'passed',
        engine_after_contain: 'passed',
        worker_after_contain: 'passed',
        engine_before_commit: 'passed',
        worker_before_commit: 'passed',
        engine_after_commit: 'passed',
        worker_after_commit: 'passed',
      },
    },
    coverage: {
      journal: 85,
      step: 85,
      lease: 85,
      git: 85,
      runner: 85,
      contain: 85,
    },
  }

  test('CA1 — Dado repositório limpo no Windows e três resultados válidos, grava artefato EvidenceV1 com duração medida', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-ca1-'))
    try {
      const outputPath = path.join(tmpDir, 'docs', 'operations', 'slice-1-windows.json')
      const fakeParity93 = async () => ({
        passed: 93,
        failed: 0,
        skipped: 0,
        workers: 4,
        duration_ms: 120000,
      })
      const fakeCrash12 = async () => ({
        passed: 12,
        failed: 0,
        cells: { ...validEvidenceLiteral.crash_matrix.cells },
      })
      const fakeCoverage85 = async () => ({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
        contain: 85,
      })
      const fakeCleanGit = (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return { status: 0, stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' }
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { status: 0, stdout: '', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }

      const result = await recordSlice1Evidence({
        repoDir: tmpDir,
        outputPath,
        platform: 'win32',
        nodeVersion: 'v22.20.0',
        runParity: fakeParity93,
        runCrashMatrix: fakeCrash12,
        runCoverage: fakeCoverage85,
        runGit: fakeCleanGit,
        now: () => 1700000000000,
      })

      expect(result).toEqual(validEvidenceLiteral)
      expect(fs.existsSync(outputPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      expect(written).toEqual(validEvidenceLiteral)
      expect(fs.readFileSync(outputPath, 'utf8').endsWith('\n')).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('CA2 — Dada paridade com 93/0/0 e 12 células passed aceita, paridade 92 ou célula ausente recusa com saída 2', () => {
    // Sucesso com objeto literal completo
    const accepted = validateEvidence(validEvidenceLiteral)
    expect(accepted).toEqual(validEvidenceLiteral)
    expect(CRASH_MATRIX_CELLS).toHaveLength(12)

    // Paridade 92
    const parity92 = {
      ...validEvidenceLiteral,
      parity: {
        passed: 92,
        failed: 0,
        skipped: 0,
      },
    }
    expect(() => validateEvidence(parity92)).toThrow(AdeError)
    try {
      validateEvidence(parity92)
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      expect((err as AdeError).code).toBe('slice1_evidence_invalid')
      expect((err as AdeError).exitCode).toBe(2)
    }

    // Célula ausente
    const missingCellCells = { ...validEvidenceLiteral.crash_matrix.cells }
    delete (missingCellCells as Record<string, unknown>).worker_after_commit
    const missingCell = {
      ...validEvidenceLiteral,
      crash_matrix: {
        passed: 11,
        failed: 0,
        cells: missingCellCells,
      },
    }
    expect(() => validateEvidence(missingCell)).toThrow(AdeError)
    try {
      validateEvidence(missingCell)
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      expect((err as AdeError).code).toBe('slice1_evidence_invalid')
      expect((err as AdeError).exitCode).toBe(2)
    }
  })

  test('CA3 — Dadas seis coberturas >= 85 aceita, cobertura 84.99 ou ausente recusa com saída 2 e preserva destino', async () => {
    // Validação pura: cobertura 84.99
    const cov8499 = {
      ...validEvidenceLiteral,
      coverage: {
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
        contain: 84.99,
      },
    }
    expect(() => validateEvidence(cov8499)).toThrow(AdeError)
    try {
      validateEvidence(cov8499)
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      expect((err as AdeError).code).toBe('slice1_evidence_invalid')
      expect((err as AdeError).exitCode).toBe(2)
    }

    // Validação pura: módulo ausente
    const covMissingMod = {
      ...validEvidenceLiteral,
      coverage: {
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
      },
    }
    expect(() => validateEvidence(covMissingMod)).toThrow(AdeError)

    // Preservação do destino na recusa
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-ca3-'))
    try {
      const outputPath = path.join(tmpDir, 'docs', 'operations', 'slice-1-windows.json')
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      const initialContent = '{"intact":"preservado"}\n'
      fs.writeFileSync(outputPath, initialContent, 'utf8')

      const fakeParity93 = async () => ({
        passed: 93,
        failed: 0,
        skipped: 0,
        workers: 4,
        duration_ms: 120000,
      })
      const fakeCrash12 = async () => ({
        passed: 12,
        failed: 0,
        cells: { ...validEvidenceLiteral.crash_matrix.cells },
      })
      const fakeCoverage8499 = async () => ({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
        contain: 84.99,
      })
      const fakeCleanGit = (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return { status: 0, stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' }
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { status: 0, stdout: '', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }

      await expect(
        recordSlice1Evidence({
          repoDir: tmpDir,
          outputPath,
          platform: 'win32',
          nodeVersion: 'v22.20.0',
          runParity: fakeParity93,
          runCrashMatrix: fakeCrash12,
          runCoverage: fakeCoverage8499,
          runGit: fakeCleanGit,
        }),
      ).rejects.toThrow(AdeError)

      expect(fs.readFileSync(outputPath, 'utf8')).toBe(initialContent)
      const siblingFiles = fs.readdirSync(path.dirname(outputPath))
      expect(siblingFiles.filter((f) => f.includes('.tmp'))).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('CA4 — Repositório sujo, plataforma linux, hash curto ou falha de comando recusa com slice1_evidence_invalid e preserva destino', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-ca4-'))
    try {
      const outputPath = path.join(tmpDir, 'docs', 'operations', 'slice-1-windows.json')
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      const initialContent = '{"intact":"permanece"}\n'
      fs.writeFileSync(outputPath, initialContent, 'utf8')

      const fakeParity93 = async () => ({
        passed: 93,
        failed: 0,
        skipped: 0,
        workers: 4,
        duration_ms: 120000,
      })
      const fakeCrash12 = async () => ({
        passed: 12,
        failed: 0,
        cells: { ...validEvidenceLiteral.crash_matrix.cells },
      })
      const fakeCoverage85 = async () => ({
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
        contain: 85,
      })

      // 1. Plataforma Linux
      await expect(
        recordSlice1Evidence({
          repoDir: tmpDir,
          outputPath,
          platform: 'linux',
          nodeVersion: 'v22.20.0',
          runParity: fakeParity93,
          runCrashMatrix: fakeCrash12,
          runCoverage: fakeCoverage85,
          runGit: () => ({ status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }),
        }),
      ).rejects.toMatchObject({
        code: 'slice1_evidence_invalid',
        exitCode: 2,
      })
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(initialContent)

      // 2. Hash curto
      const fakeGitShortHash = (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: 'aaaa\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return { status: 0, stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      await expect(
        recordSlice1Evidence({
          repoDir: tmpDir,
          outputPath,
          platform: 'win32',
          nodeVersion: 'v22.20.0',
          runParity: fakeParity93,
          runCrashMatrix: fakeCrash12,
          runCoverage: fakeCoverage85,
          runGit: fakeGitShortHash,
        }),
      ).rejects.toMatchObject({
        code: 'slice1_evidence_invalid',
        exitCode: 2,
      })
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(initialContent)

      // 3. Repositório sujo fora do destino
      const fakeGitDirty = (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return { status: 0, stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' }
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { status: 0, stdout: ' M src/index.js\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      await expect(
        recordSlice1Evidence({
          repoDir: tmpDir,
          outputPath,
          platform: 'win32',
          nodeVersion: 'v22.20.0',
          runParity: fakeParity93,
          runCrashMatrix: fakeCrash12,
          runCoverage: fakeCoverage85,
          runGit: fakeGitDirty,
        }),
      ).rejects.toMatchObject({
        code: 'slice1_evidence_invalid',
        exitCode: 2,
      })
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(initialContent)

      // 4. Falha de comando (git status falha com exit code diferente de 0)
      const fakeGitFail = () => ({
        status: 1,
        stdout: '',
        stderr: 'fatal: not a git repository\n',
      })
      await expect(
        recordSlice1Evidence({
          repoDir: tmpDir,
          outputPath,
          platform: 'win32',
          nodeVersion: 'v22.20.0',
          runParity: fakeParity93,
          runCrashMatrix: fakeCrash12,
          runCoverage: fakeCoverage85,
          runGit: fakeGitFail,
        }),
      ).rejects.toMatchObject({
        code: 'slice1_evidence_invalid',
        exitCode: 2,
      })
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(initialContent)

      // 5. Sucesso quando a sujeira é SOMENTE o próprio outputPath
      const relOutputPath = path.relative(tmpDir, outputPath).replace(/\\/g, '/')
      const fakeGitDirtySelfOnly = (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') {
          return { status: 0, stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' }
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { status: 0, stdout: ` M ${relOutputPath}\n`, stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      const selfOnlyRes = await recordSlice1Evidence({
        repoDir: tmpDir,
        outputPath,
        platform: 'win32',
        nodeVersion: 'v22.20.0',
        runParity: fakeParity93,
        runCrashMatrix: fakeCrash12,
        runCoverage: fakeCoverage85,
        runGit: fakeGitDirtySelfOnly,
      })
      expect(selfOnlyRes).toEqual(validEvidenceLiteral)
      expect(fs.readFileSync(outputPath, 'utf8')).not.toBe(initialContent)
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual(validEvidenceLiteral)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
