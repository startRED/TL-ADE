import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main as indexMain } from '../src/cli/index.ts'
import { diagnoseDocs, generateDocProjections } from '../src/docs/projection.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

function makeSink(): { (s: string): void; write: (s: string) => void; readonly text: string } {
  let text = ''
  const fn = (s: string) => {
    text += s
  }
  fn.write = (s: string) => {
    text += s
  }
  Object.defineProperty(fn, 'text', {
    get() {
      return text
    },
  })
  return fn as { (s: string): void; write: (s: string) => void; readonly text: string }
}

describe('Story: Expor estado e qualidade derivados de evidências', () => {
  // Critério 1: projeções reproduzíveis distinguem implementado, validado, indisponível e pendente
  test('projecoes_reproduziveis_distinguem_implementado_validado_indisponivel_e_pendente', async () => {
    const repoDir = makeTmpDir('ade-docs-test-c1-')
    tmpDirs.push(repoDir)

    const missionDir = path.join(repoDir, '.ade', 'missions', 'm-test')
    mkdirSync(missionDir, { recursive: true })

    // Criamos arquivos e journal com 4 tipos de unidades / capacidades:
    // U-VAL: implementado e validado por evidência (eval passou e revisão aprovada)
    // U-IMP: implementado (commit registrado), mas sem validação de evidência completa
    // U-IND: indisponível (ex.: dependência externa ou capacidade indisponível/sem canary)
    // U-PEN: pendente (em progresso ou aguardando operador)
    const journalEvents = [
      { kind: 'story_started', data: { unit: 'U-VAL' } },
      {
        kind: 'eval_run',
        data: { unit: 'U-VAL', passed: true, score: 1.0, evidence_ref: 'eval:u-val:pass' },
      },
      {
        kind: 'review_verdict',
        data: { unit: 'U-VAL', approved: true, review_result_ref: 'review:u-val:v2' },
      },
      {
        kind: 'story_done',
        data: { unit: 'U-VAL', status: 'committed', commit: 'c01111111111' },
      },

      { kind: 'story_started', data: { unit: 'U-IMP' } },
      {
        kind: 'story_done',
        data: { unit: 'U-IMP', status: 'committed', commit: 'c02222222222' },
      },

      { kind: 'story_started', data: { unit: 'U-IND' } },
      {
        kind: 'story_done',
        data: { unit: 'U-IND', status: 'parked', reason: 'family_without_canary' },
      },

      { kind: 'story_started', data: { unit: 'U-PEN' } },
      {
        kind: 'story_done',
        data: { unit: 'U-PEN', status: 'awaiting_operator', reason: 'preflight' },
      },
    ]

    const journalLines = journalEvents.map((e, idx) =>
      JSON.stringify({ seq: idx + 1, time: '2026-09-20T12:00:00.000Z', ...e }),
    )
    writeFileSync(path.join(missionDir, 'journal.jsonl'), journalLines.join('\n') + '\n', 'utf8')

    const capabilities = {
      format_version: 1,
      models: [
        { id: 'claude-sonnet-5', vendor: 'anthropic', effort: 'medium' },
        { id: 'codex-preview', vendor: 'openai', effort: 'medium' },
      ],
      probe_ok: true,
      probe_mode: 'real',
    }

    const firstRun = generateDocProjections({
      journalEvents,
      capabilities,
    })

    const secondRun = generateDocProjections({
      journalEvents,
      capabilities,
    })

    // Reprodutibilidade estrita (mesma entrada gera projeção idêntica caractere a caractere)
    expect(firstRun['current-status.md']).toBe(secondRun['current-status.md'])
    expect(firstRun['capabilities.md']).toBe(secondRun['capabilities.md'])
    expect(firstRun['architecture-map.md']).toBe(secondRun['architecture-map.md'])
    expect(firstRun['quality-report.md']).toBe(secondRun['quality-report.md'])

    const statusContent = firstRun['current-status.md']
    // Distingue as 4 categorias
    expect(statusContent).toMatch(/validado/i)
    expect(statusContent).toMatch(/implementado/i)
    expect(statusContent).toMatch(/indispon[íi]vel/i)
    expect(statusContent).toMatch(/pendente/i)

    // U-VAL deve estar classificado como validado
    expect(statusContent).toContain('U-VAL')
    // U-IMP deve estar classificado como implementado
    expect(statusContent).toContain('U-IMP')
    // U-IND deve estar classificado como indisponível
    expect(statusContent).toContain('U-IND')
    // U-PEN deve estar classificado como pendente
    expect(statusContent).toContain('U-PEN')
  })

  // Critério 2: referências inválidas ou evidências antigas são apontadas
  test('referencias_invalidas_ou_evidencias_antigas_sao_apontadas', async () => {
    const repoDir = makeTmpDir('ade-docs-test-c2-')
    tmpDirs.push(repoDir)

    const docsDir = path.join(repoDir, 'docs')
    mkdirSync(docsDir, { recursive: true })

    // Cria doc com referência quebrada
    const brokenRefDoc = path.join(docsDir, 'broken-links.md')
    writeFileSync(
      brokenRefDoc,
      `# Teste de Links\n\nVeja o arquivo [inexistente](nao-existe.md) e o codigo em [arquivo_fantasma](src/missing.js).\n`,
      'utf8',
    )

    // Cria doc com front-matter verified e referência a arquivo modificado posteriormente
    const staleDoc = path.join(docsDir, 'stale-spec.md')
    const existingCode = path.join(repoDir, 'src', 'feature.js')
    mkdirSync(path.dirname(existingCode), { recursive: true })
    writeFileSync(existingCode, 'export const v = 2;\n', 'utf8')

    writeFileSync(
      staleDoc,
      `---
verified: 1111111
verified_at: 2026-09-01T00:00:00.000Z
cites:
  - src/feature.js
---
# Spec Desatualizada
Baseado em [feature](src/feature.js).
`,
      'utf8',
    )

    // Histórico de alterações simulado indicando que src/feature.js foi alterado no commit 2222222 em 2026-09-15
    const fileCommits = {
      'src/feature.js': {
        commit: '2222222',
        updated_at: '2026-09-15T00:00:00.000Z',
      },
    }

    const diagnosis = diagnoseDocs({
      repoDir,
      fileCommits,
    })

    expect(diagnosis.invalid_references.length).toBeGreaterThan(0)
    const invalidPaths = diagnosis.invalid_references.map((r) => r.target)
    expect(invalidPaths).toContain('nao-existe.md')
    expect(invalidPaths).toContain('src/missing.js')

    expect(diagnosis.stale_documents.length).toBeGreaterThan(0)
    const staleEntry = diagnosis.stale_documents.find((d) => d.file.includes('stale-spec.md'))
    expect(staleEntry).toBeDefined()
    expect(staleEntry?.reason).toMatch(/stale|desatualizad/i)
  })

  // Critério 3: sincronização e diagnóstico de documentos cumprem os comandos aprovados, e sugestões de limpeza não apagam documentos automaticamente
  test('sincronizacao_e_diagnostico_cumprem_comandos_aprovados_e_limpeza_nao_apaga_automaticamente', async () => {
    const repoDir = makeTmpDir('ade-docs-test-c3-')
    tmpDirs.push(repoDir)

    const docsDir = path.join(repoDir, 'docs')
    mkdirSync(docsDir, { recursive: true })

    // Cria doc orfão/obsoleto que será sugerido para limpeza
    const obsoleteDoc = path.join(docsDir, 'obsolete.md')
    writeFileSync(
      obsoleteDoc,
      `# Documento obsoleto\n[link_quebrado](inexistente.md)\n`,
      'utf8',
    )

    const stdout = makeSink()
    const stderr = makeSink()

    // 1. Comando ade docs sync --repo <dir>
    const exitSync = await indexMain(['docs', 'sync', '--repo', repoDir], {
      stdout,
      stderr,
      env: {},
    })
    expect(exitSync).toBe(0)

    const generatedDir = path.join(docsDir, 'generated')
    expect(existsSync(path.join(generatedDir, 'current-status.md'))).toBe(true)
    expect(existsSync(path.join(generatedDir, 'capabilities.md'))).toBe(true)
    expect(existsSync(path.join(generatedDir, 'architecture-map.md'))).toBe(true)
    expect(existsSync(path.join(generatedDir, 'quality-report.md'))).toBe(true)

    // 2. Comando ade doctor --docs --repo <dir>
    const docDoctorStdout = makeSink()
    const docDoctorStderr = makeSink()
    const exitDoctor = await indexMain(['doctor', '--docs', '--repo', repoDir], {
      stdout: docDoctorStdout,
      stderr: docDoctorStderr,
      env: {},
    })
    expect(exitDoctor).toBe(0)
    expect(docDoctorStdout.text).toMatch(/diagn[oó]stico/i)

    // 3. Comando ade gc --docs --repo <dir>
    const gcStdout = makeSink()
    const gcStderr = makeSink()
    const exitGc = await indexMain(['gc', '--docs', '--repo', repoDir], {
      stdout: gcStdout,
      stderr: gcStderr,
      env: {},
    })
    expect(exitGc).toBe(0)
    expect(gcStdout.text).toMatch(/sugest/i)

    // Regra crítica do critério 3: "sugestões de limpeza não apagam documentos automaticamente"
    expect(existsSync(obsoleteDoc)).toBe(true)
  })
})
