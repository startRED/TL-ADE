import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

describe('slice1 publication', () => {
  // CA1 — Dado o workflow, quando sua configuração for inspecionada, então existe o job
  // slice1-evidence-linux em ubuntu-latest com Node 22, paridade, crash matrix direta,
  // cobertura e upload slice-1-linux-evidence, sem segredo configurado.
  test('CA1 — Dado o workflow, quando sua configuração for inspecionada, então existe o job slice1-evidence-linux em ubuntu-latest com Node 22, paridade, crash matrix direta, cobertura e upload slice-1-linux-evidence, sem segredo configurado', () => {
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'ci.yml')
    expect(fs.existsSync(workflowPath)).toBe(true)

    const workflowContent = fs.readFileSync(workflowPath, 'utf8')

    // Deve conter o job slice1-evidence-linux
    expect(workflowContent).toContain('slice1-evidence-linux:')

    // Extrair o bloco do job slice1-evidence-linux
    const jobMatch = workflowContent.match(
      /slice1-evidence-linux:([\s\S]*?)(?=\n {0,2}[a-zA-Z0-9_-]+:|$)/,
    )
    expect(jobMatch).not.toBeNull()
    const jobSection = jobMatch ? jobMatch[1] : ''

    // runs-on ubuntu-latest
    expect(jobSection).toMatch(/runs-on:\s*ubuntu-latest/)

    // Node 22 configurado
    expect(jobSection).toMatch(/node-version:\s*['"]?22['"]?/)

    // Execuções determinísticas exigidas pela receita
    expect(jobSection).toContain('npm ci')
    expect(jobSection).toContain('npm run test:parity')
    expect(jobSection).toContain(
      'node node_modules/vitest/vitest.mjs run tests/parity/crash-matrix.test.ts',
    )
    expect(jobSection).toContain('npm run test:durability-coverage')

    // Upload de artefato slice-1-linux-evidence usando v4
    expect(jobSection).toMatch(/actions\/upload-artifact@v4/)
    expect(jobSection).toMatch(/name:\s*slice-1-linux-evidence/)

    // Sem segredos configurados
    expect(jobSection).not.toContain('secrets.')
  })

  // CA2 — Dada a declaração Linux versionada, quando for lida, então contém schema 1,
  // sistema linux, status not_executed_locally, results null e a receita de quatro
  // comandos, sem números copiados do Windows.
  test('CA2 — Dada a declaração Linux versionada, quando for lida, então contém schema 1, sistema linux, status not_executed_locally, results null e a receita de quatro comandos, sem números copiados do Windows', () => {
    const declarationPath = path.join(ROOT, 'docs', 'operations', 'slice-1-linux.json')
    expect(fs.existsSync(declarationPath)).toBe(true)

    const rawContent = fs.readFileSync(declarationPath, 'utf8')
    const declaration = JSON.parse(rawContent)

    // Estrutura literal exigida
    expect(declaration).toEqual({
      schema_version: 1,
      system: 'linux',
      status: 'not_executed_locally',
      results: null,
      recipe: [
        'npm ci',
        'npm run test:parity',
        'node node_modules/vitest/vitest.mjs run tests/parity/crash-matrix.test.ts',
        'npm run test:durability-coverage',
      ],
    })

    // Sem resultados copiados do Windows
    expect(declaration.results).toBeNull()
    expect(rawContent).not.toContain('duration_ms')
    expect(rawContent).not.toContain('passed')
    expect(rawContent).not.toContain('failed')
  })

  // CA3 — Dado o artefato Windows válido de s3, quando a conferência for lida,
  // então S1-02, S1-03 e RM-COBERTURA citam seu commit e caminho, enquanto a coluna
  // Linux permanece não comprovado e o estado geral continua fechamento pendente.
  test('CA3 — Dado o artefato Windows válido de s3, quando a conferência for lida, então S1-02, S1-03 e RM-COBERTURA citam seu commit e caminho, enquanto a coluna Linux permanece não comprovado e o estado geral continua fechamento pendente', () => {
    const fechamentoPath = path.join(ROOT, 'docs', 'plans', 'slice-1-fechamento.md')
    expect(fs.existsSync(fechamentoPath)).toBe(true)

    const content = fs.readFileSync(fechamentoPath, 'utf8')

    // Estado geral continua fechamento pendente
    expect(content).toContain('Estado: **fechamento pendente**')

    // Linhas S1-02, S1-03 e RM-COBERTURA
    const lines = content.split('\n')
    const s102Line = lines.find((line) => line.includes('| S1-02 |'))
    const s103Line = lines.find((line) => line.includes('| S1-03 |'))
    const rmCobLine = lines.find((line) => line.includes('| RM-COBERTURA |'))

    expect(s102Line).toBeDefined()
    expect(s103Line).toBeDefined()
    expect(rmCobLine).toBeDefined()

    // Citação do caminho docs/operations/slice-1-windows.json
    expect(s102Line).toContain('docs/operations/slice-1-windows.json')
    expect(s103Line).toContain('docs/operations/slice-1-windows.json')
    expect(rmCobLine).toContain('docs/operations/slice-1-windows.json')

    // Confrontar o commit da matriz com o artefato Windows quando disponível
    const windowsPath = path.join(ROOT, 'docs', 'operations', 'slice-1-windows.json')
    if (fs.existsSync(windowsPath)) {
      const winEvidence = JSON.parse(fs.readFileSync(windowsPath, 'utf8'))
      expect(winEvidence.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(s102Line).toContain(winEvidence.commit)
      expect(s103Line).toContain(winEvidence.commit)
      expect(rmCobLine).toContain(winEvidence.commit)
    } else {
      expect(s102Line).toMatch(/[0-9a-f]{40}/)
      expect(s103Line).toMatch(/[0-9a-f]{40}/)
      expect(rmCobLine).toMatch(/[0-9a-f]{40}/)
    }

    // Coluna Linux permanece não comprovado
    expect(content).toContain('não comprovado')
    expect(content).not.toMatch(/\|\s*Linux\s*\|\s*comprovado\s*\|/)
  })

  // CA4 — Dada uma declaração Linux alterada para status: 'executed' sem artefato baixado do job,
  // quando a publicação for validada, então ocorre linux_evidence_unverified com exitCode: 2
  // e a conferência não pode promover Linux.
  test('CA4 — Dada uma declaração Linux alterada para status executed sem artefato baixado do job, quando a publicação for validada, então ocorre linux_evidence_unverified com exitCode 2 e a conferência não pode promover Linux', async () => {
    // Carrega a função exportada de scripts/validate-slice1-publication.js
    const { validateLinuxPublication } = await import('../scripts/validate-slice1-publication.js')
    expect(typeof validateLinuxPublication).toBe('function')

    const localDeclaration = {
      schema_version: 1,
      system: 'linux',
      status: 'not_executed_locally',
      results: null,
      recipe: [
        'npm ci',
        'npm run test:parity',
        'node node_modules/vitest/vitest.mjs run tests/parity/crash-matrix.test.ts',
        'npm run test:durability-coverage',
      ],
    }

    // Declaração local válida é aceita
    const accepted = validateLinuxPublication(localDeclaration)
    expect(accepted).toMatchObject({ status: 'not_executed_locally' })

    // Se status for executed sem ciEvidencePath ou com arquivo inexistente, lança linux_evidence_unverified com exitCode 2
    const executedDeclaration = {
      ...localDeclaration,
      status: 'executed',
    }

    expect(() => validateLinuxPublication(executedDeclaration)).toThrowError(AdeError)
    try {
      validateLinuxPublication(executedDeclaration)
      expect.unreachable('deveria lançar AdeError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('linux_evidence_unverified')
      expect(err.exitCode).toBe(2)
    }

    // Testar validador com diretório temporário vazio
    const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-val-empty-'))
    const nonExistentCiPath = path.join(emptyTmpDir, 'slice-1-linux-evidence.json')
    try {
      expect(() =>
        validateLinuxPublication(executedDeclaration, { ciEvidencePath: nonExistentCiPath }),
      ).toThrowError(AdeError)
      try {
        validateLinuxPublication(executedDeclaration, { ciEvidencePath: nonExistentCiPath })
        expect.unreachable('deveria falhar com arquivo inexistente')
      } catch (err: any) {
        expect(err.code).toBe('linux_evidence_unverified')
        expect(err.exitCode).toBe(2)
      }
    } finally {
      fs.rmSync(emptyTmpDir, { recursive: true, force: true })
    }

    // Testar com artefato CI válido
    const validTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-val-valid-'))
    const validCiPath = path.join(validTmpDir, 'slice-1-linux-evidence.json')
    const validCiData = {
      schema_version: 1,
      status: 'executed',
      system: 'linux',
      commit: '1234567890abcdef1234567890abcdef12345678',
      tree: 'abcdef1234567890abcdef1234567890abcdef12',
      node_version: 'v22.20.0',
      workers: 4,
      duration_ms: 100000,
      parity: { passed: 93, failed: 0, skipped: 0 },
      crash_matrix: { passed: 12, failed: 0 },
      coverage: {
        journal: 85,
        step: 85,
        lease: 85,
        git: 85,
        runner: 85,
        contain: 85,
      },
    }
    fs.writeFileSync(validCiPath, JSON.stringify(validCiData, null, 2))
    try {
      const verified = validateLinuxPublication(executedDeclaration, {
        ciEvidencePath: validCiPath,
      })
      expect(verified).toBeDefined()
    } finally {
      fs.rmSync(validTmpDir, { recursive: true, force: true })
    }

    // Testar com artefato CI inválido (ex: cobertura insuficiente)
    const invalidTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-val-bad-'))
    const badCiPath = path.join(invalidTmpDir, 'slice-1-linux-evidence.json')
    const badCiData = {
      ...validCiData,
      coverage: {
        ...validCiData.coverage,
        journal: 84, // abaixo de 85
      },
    }
    fs.writeFileSync(badCiPath, JSON.stringify(badCiData, null, 2))
    try {
      expect(() =>
        validateLinuxPublication(executedDeclaration, { ciEvidencePath: badCiPath }),
      ).toThrowError(AdeError)
      try {
        validateLinuxPublication(executedDeclaration, { ciEvidencePath: badCiPath })
      } catch (err: any) {
        expect(err.code).toBe('linux_evidence_unverified')
        expect(err.exitCode).toBe(2)
      }
    } finally {
      fs.rmSync(invalidTmpDir, { recursive: true, force: true })
    }
  })
})
