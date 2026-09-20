import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { AdeError } from '../../src/journal/errors.js'
import { selectTests } from '../../vitest.config.mjs'
import {
  ParityCaseMissingError,
  ParityCaseSkippedError,
  runParity,
  validateParityResult,
  type VitestJsonReport,
} from '../../scripts/run-parity.js'
import { contractStub } from './contract-stubs.test.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const MANIFEST_PATH = path.join(ROOT, 'parity-name-map.json')
const EXPECTED_MANIFEST_SHA256 = 'bbadad29fa7f3257b189427cbc4eb1eeb39c2bbb432cbd8447353220b9edeecd'

export class ParityManifestInvalidError extends AdeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('parity_manifest_invalid', message, 4, details)
  }
}

export { ParityCaseMissingError, ParityCaseSkippedError }

export interface ParityCase {
  source: string
  target: string
  status: 'same' | 'renamed'
  reason: string | null
  test_file: string
}

export interface ParityManifest {
  schema_version: number
  reference: {
    project: string
    version: string
    file: string
    count: number
  }
  cases: ParityCase[]
}

/**
 * Valida o inventário e integridade do manifesto de paridade.
 * O campo test_file é tratado como metadado histórico de origem;
 * a validação executável é realizada pela presença dos targets no relatório Vitest.
 *
 * @param {ParityManifest} manifest - Objeto do manifesto a ser validado
 * @param {{ report?: VitestJsonReport; repoDir?: string }} [options] - Opções com relatório JSON ou contexto
 * @returns {{ total: number, valid: boolean }}
 */
export function validateManifest(
  manifest: ParityManifest,
  options?: { report?: VitestJsonReport; repoDir?: string },
): { total: number; valid: boolean } {
  if (!manifest || typeof manifest !== 'object') {
    throw new ParityManifestInvalidError('Manifesto deve ser um objeto JSON válido')
  }

  if (manifest.schema_version !== 1) {
    throw new ParityManifestInvalidError('schema_version deve ser 1')
  }

  if (
    !manifest.reference ||
    manifest.reference.count !== 93 ||
    manifest.reference.project !== 'tl-orchestrator-release' ||
    manifest.reference.version !== '0.17.0' ||
    manifest.reference.file !== 'scripts/tests/test_tl_runtime.py'
  ) {
    throw new ParityManifestInvalidError('reference inválida no manifesto')
  }

  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 93) {
    throw new ParityManifestInvalidError(
      `Manifesto deve conter exatamente 93 casos, encontrado: ${manifest.cases?.length ?? 0}`,
    )
  }

  const seenSources = new Set<string>()
  const seenTargets = new Set<string>()

  for (let i = 0; i < manifest.cases.length; i++) {
    const c = manifest.cases[i]
    if (!c || typeof c !== 'object') {
      throw new ParityManifestInvalidError(`Caso no índice ${i} deve ser um objeto`)
    }

    if (!c.source || typeof c.source !== 'string') {
      throw new ParityManifestInvalidError(`Caso no índice ${i} possui source inválido`)
    }

    if (!c.target || typeof c.target !== 'string') {
      throw new ParityManifestInvalidError(`Caso no índice ${i} possui target inválido`)
    }

    if (seenSources.has(c.source)) {
      throw new ParityManifestInvalidError(`Source duplicado: ${c.source}`)
    }
    seenSources.add(c.source)

    if (seenTargets.has(c.target)) {
      throw new ParityManifestInvalidError(`Target duplicado: ${c.target}`)
    }
    seenTargets.add(c.target)

    if (c.status !== 'same' && c.status !== 'renamed') {
      throw new ParityManifestInvalidError(`Status inválido para ${c.source}: ${c.status}`)
    }

    if (c.status === 'renamed') {
      if (typeof c.reason !== 'string' || c.reason.trim().length === 0) {
        throw new ParityManifestInvalidError(`Caso renomeado ${c.source} exige reason não vazio`)
      }
    } else {
      if (c.reason !== null) {
        throw new ParityManifestInvalidError(`Caso 'same' ${c.source} deve ter reason nulo`)
      }
      const expectedTarget = c.source.replace(/^test_/, '')
      if (c.target !== expectedTarget) {
        throw new ParityManifestInvalidError(
          `Caso 'same' ${c.source} deve ter target igual sem prefixo test_: esperado ${expectedTarget}, obtido ${c.target}`,
        )
      }
    }

    if (!c.test_file || typeof c.test_file !== 'string') {
      throw new ParityManifestInvalidError(`Caso ${c.source} possui test_file ausente ou inválido`)
    }
  }

  if (options?.report) {
    validateParityResult(manifest, options.report)
  }

  return { total: manifest.cases.length, valid: true }
}

describe('manifest parity', () => {
  // CA1 antigo atualizado: Dado parity-name-map.json, quando o inventário é validado, então há exatamente 93 fontes
  // e 93 destinos únicos declarados no mapa; a resolução de alvos ocorre pelo relatório e não por arquivos no disco.
  test('ca1_inventory_has_93_unique_sources_and_targets_and_resolves_against_fixture', () => {
    expect(existsSync(MANIFEST_PATH), 'parity-name-map.json deve existir na raiz').toBe(true)

    const raw = readFileSync(MANIFEST_PATH, 'utf8')
    const manifest = JSON.parse(raw) as ParityManifest

    // Validação estrutural do manifesto oficial
    const result = validateManifest(manifest)
    expect(result).toEqual({ total: 93, valid: true })

    // Resolução contra relatório JSON com os 93 alvos
    const mockReport: VitestJsonReport = {
      testResults: [
        {
          assertionResults: manifest.cases.map((c) => ({
            title: c.target,
            status: 'passed',
          })),
        },
      ],
    }
    const reportResult = validateManifest(manifest, { report: mockReport })
    expect(reportResult).toEqual({ total: 93, valid: true })

    // Mapa com target inexistente no relatório -> erro parity_case_missing com código 2
    const missingTargetManifest: ParityManifest = {
      ...manifest,
      cases: [
        ...manifest.cases.slice(0, 92),
        {
          source: 'test_ausente',
          target: 'ausente',
          status: 'same',
          reason: null,
          test_file: 'tests/parity/ausente.test.ts',
        },
      ],
    }

    expect(() => validateManifest(missingTargetManifest, { report: mockReport })).toThrowError(
      expect.objectContaining({ code: 'parity_case_missing', exitCode: 2 }),
    )
  })

  // CA2: Dado um caso com status 'renamed', quando o mapa é validado, então reason é texto não vazio;
  // um caso 'same' usa target igual ao source sem o prefixo test_.
  test('ca2_renamed_cases_require_reason_and_same_cases_strip_test_prefix', () => {
    const validRenamedCase: ParityCase = {
      source: 'test_dirty_tree_before_unit_stops',
      target: 'dirty_worktree_before_story_stops',
      status: 'renamed',
      reason: 'guarda por worktree',
      test_file: 'tests/parity/dirty_worktree_before_story_stops.test.ts',
    }

    const testManifest: ParityManifest = {
      schema_version: 1,
      reference: {
        project: 'tl-orchestrator-release',
        version: '0.17.0',
        file: 'scripts/tests/test_tl_runtime.py',
        count: 93,
      },
      cases: Array.from({ length: 93 }, (_, i) =>
        i === 0
          ? validRenamedCase
          : {
              source: `test_case_${i}`,
              target: `case_${i}`,
              status: 'same' as const,
              reason: null,
              test_file: `tests/parity/case_${i}.test.ts`,
            },
      ),
    }

    expect(validateManifest(testManifest)).toEqual({ total: 93, valid: true })

    // Casos inválidos: renamed sem reason
    const invalidReasonManifest: ParityManifest = {
      ...testManifest,
      cases: [
        { ...validRenamedCase, reason: '' },
        ...testManifest.cases.slice(1),
      ],
    }
    expect(() => validateManifest(invalidReasonManifest)).toThrowError(
      expect.objectContaining({ code: 'parity_manifest_invalid' }),
    )

    // Casos inválidos: 'same' com target divergente de source sem test_
    const invalidSameTargetManifest: ParityManifest = {
      ...testManifest,
      cases: [
        testManifest.cases[0],
        {
          source: 'test_clean_tree',
          target: 'divergent_tree',
          status: 'same',
          reason: null,
          test_file: 'tests/parity/divergent_tree.test.ts',
        },
        ...testManifest.cases.slice(2),
      ],
    }
    expect(() => validateManifest(invalidSameTargetManifest)).toThrowError(
      expect.objectContaining({ code: 'parity_manifest_invalid' }),
    )
  })

  // CA3: Dado o alvo de paridade, quando sua configuração é inspecionada, então ADE_PARITY=1
  // fixa quatro workers, inclui somente tests/parity/**, exclui tests/probes/** e usa o runner Node multiplataforma.
  test('ca3_parity_target_config_has_four_workers_isolated_inclusion_and_no_external_calls', () => {
    const parityConfig = selectTests({ ADE_PARITY: '1' })
    expect(parityConfig).toEqual({
      include: ['tests/parity/**/*.test.ts'],
      exclude: ['tests/probes/**'],
      minWorkers: 4,
      maxWorkers: 4,
    })

    const defaultConfig = selectTests({})
    expect(defaultConfig.include).toEqual(['tests/**/*.test.ts'])
    expect(defaultConfig.exclude).toContain('tests/probes/**')

    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(pkg.scripts?.['test:parity']).toBe('node scripts/run-parity.js')
    expect(pkg.scripts?.['test:probes']).toBeDefined()
    expect(pkg.scripts?.['test:probes']).not.toMatch(/\b(claude|codex|gh|https?:\/\/)/i)
  })

  // CA4: Dado o ADR 0024, o charter e o roadmap, quando os registros são lidos, então a autorização
  // até a v1, a ordem obrigatória dos marcos e o limite deste épico aparecem sem alterar os ADRs 0001–0023.
  test('ca4_adr_0024_charter_and_roadmap_record_v1_authorization_and_sequence', () => {
    const adr24Path = path.join(ROOT, 'docs/adr/0024-autorizacao-roadmap-ate-v1.md')
    expect(existsSync(adr24Path), 'ADR 0024 deve existir').toBe(true)
    const adr24 = readFileSync(adr24Path, 'utf8')

    expect(adr24).toMatch(/Erick/i)
    expect(adr24).toContain('2026-09-19')
    expect(adr24).toMatch(/v1/i)
    expect(adr24).toMatch(/v0\.2/i)

    const charterPath = path.join(ROOT, 'PROJECT_CHARTER.md')
    const charter = readFileSync(charterPath, 'utf8')
    expect(charter).toMatch(/ADR 0024|0024-autorizacao-roadmap-ate-v1/i)
    expect(charter).toMatch(/v1/i)

    const roadmapPath = path.join(ROOT, 'docs/roadmap.md')
    const roadmap = readFileSync(roadmapPath, 'utf8')
    expect(roadmap).toMatch(/ADR 0024|0024-autorizacao-roadmap-ate-v1/i)
    expect(roadmap).toMatch(/v1/i)

    const adrDir = path.join(ROOT, 'docs/adr')
    for (let i = 1; i <= 23; i++) {
      const prefix = String(i).padStart(4, '0')
      const files = existsSync(adrDir)
        ? readFileSync(path.join(ROOT, 'docs/adr/README.md'), 'utf8')
        : ''
      expect(files).toContain(prefix)
    }
  })

  // CA1 novo: Dado o mapa oficial com SHA-256 indicado, quando a faixa de paridade executa,
  // informa exatamente 93 aprovados, zero falhas, zero ignorados, quatro workers e duração <= 360000 ms.
  test('ca1_parity_runner_evaluates_93_targets_and_enforces_timing_and_workers', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ParityManifest

    // Exemplo [CA1]: relatório JSON com 93 assertionResults passed e 359999 ms -> {passed:93,failed:0,skipped:0,workers:4}
    const report93: VitestJsonReport = {
      testResults: [
        {
          assertionResults: manifest.cases.map((c) => ({
            title: c.target,
            status: 'passed',
          })),
        },
      ],
    }

    const validated = validateParityResult(manifest, report93)
    expect(validated).toEqual({ passed: 93, failed: 0, skipped: 0 })

    // Dublê em memória unauthorized_push_is_never_attempted com {authorized:false} -> {attempted:false,status:'refused'}
    const stubResult = contractStub('unauthorized_push_is_never_attempted', { authorized: false })
    expect(stubResult).toEqual({ attempted: false, status: 'refused' })

    // Runner com processo falso devolvendo 93 testes aprovados e duração de 359999 ms
    const mockSpawnImpl = vi.fn(() => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      process.nextTick(() => {
        child.stdout.write(JSON.stringify(report93))
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      })
      return child
    })

    const runResult = await runParity({
      repoDir: ROOT,
      manifestPath: MANIFEST_PATH,
      timeoutMs: 360000,
      workers: 4,
      simulatedDurationMs: 359999,
      spawnImpl: mockSpawnImpl,
    })

    expect(runResult.passed).toBe(93)
    expect(runResult.failed).toBe(0)
    expect(runResult.skipped).toBe(0)
    expect(runResult.workers).toBe(4)
    expect(runResult.duration_ms).toBe(359999)
    expect(runResult.cases.length).toBe(93)

    // Duração de 360001 ms -> recusada com código 2
    await expect(
      runParity({
        repoDir: ROOT,
        manifestPath: MANIFEST_PATH,
        timeoutMs: 360000,
        workers: 4,
        simulatedDurationMs: 360001,
        spawnImpl: mockSpawnImpl,
      }),
    ).rejects.toMatchObject({
      code: 'parity_timeout',
      exitCode: 2,
    })
  })

  // CA2 novo: Dado um manifesto de prova cujo target não aparece nos resultados,
  // quando a validação termina, sai com código 2 e informa parity_case_missing e o nome ausente.
  test('ca2_missing_target_exits_code_2_parity_case_missing', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ParityManifest

    // Relatório com 92 alvos e ausência de worker_env_is_scrubbed -> código 2 parity_case_missing
    const reportWithoutScrubbed: VitestJsonReport = {
      testResults: [
        {
          assertionResults: manifest.cases
            .filter((c) => c.target !== 'worker_env_is_scrubbed')
            .map((c) => ({
              title: c.target,
              status: 'passed',
            })),
        },
      ],
    }

    try {
      validateParityResult(manifest, reportWithoutScrubbed)
      expect.fail('Deveria ter lançado ParityCaseMissingError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('parity_case_missing')
      expect(err.exitCode).toBe(2)
      expect(err.message).toContain('worker_env_is_scrubbed')
      expect(err.details).toMatchObject({ target: 'worker_env_is_scrubbed' })
    }
  })

  // CA3 novo: Dado um dos 93 alvos com resultado ignorado,
  // quando a validação termina, sai com código 2 e informa parity_case_skipped e o nome ignorado.
  test('ca3_skipped_target_exits_code_2_parity_case_skipped', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ParityManifest

    // worker_env_is_scrubbed com estado skipped -> código 2 parity_case_skipped
    const reportWithSkipped: VitestJsonReport = {
      testResults: [
        {
          assertionResults: manifest.cases.map((c) => ({
            title: c.target,
            status: c.target === 'worker_env_is_scrubbed' ? ('skipped' as const) : ('passed' as const),
          })),
        },
      ],
    }

    try {
      validateParityResult(manifest, reportWithSkipped)
      expect.fail('Deveria ter lançado ParityCaseSkippedError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('parity_case_skipped')
      expect(err.exitCode).toBe(2)
      expect(err.message).toContain('worker_env_is_scrubbed')
      expect(err.details).toMatchObject({ target: 'worker_env_is_scrubbed' })
    }
  })

  // CA4 novo: Dado o mapa oficial após a alteração, quando relido, o SHA-256 permanece
  // bbadad29fa7f3257b189427cbc4eb1eeb39c2bbb432cbd8447353220b9edeecd e zero arquivos derivados de test_file foram criados.
  test('ca4_map_hash_preserved_and_no_test_file_created', () => {
    const raw = readFileSync(MANIFEST_PATH)
    const actualHash = createHash('sha256').update(raw).digest('hex')
    expect(actualHash).toBe(EXPECTED_MANIFEST_SHA256)

    const manifest = JSON.parse(raw.toString('utf8')) as ParityManifest
    expect(manifest.cases.length).toBe(93)

    // Apenas os arquivos que já existiam na consolidação são permitidos;
    // nenhum dos 92 arquivos declarados mas historicamente inexistentes foi criado no repositório.
    const nonExistentHistoricalFiles = manifest.cases
      .map((c) => c.test_file)
      .filter((file) => file !== 'tests/parity/cli.test.ts')

    expect(nonExistentHistoricalFiles.length).toBe(92)
    for (const file of nonExistentHistoricalFiles) {
      const fullPath = path.join(ROOT, file)
      expect(existsSync(fullPath), `Arquivo fictício ${file} não deve ser criado`).toBe(false)
    }
  })

  // CA5 novo: Argumento gh pr list no executor injetado -> recusado antes do spawn;
  // sem chamadas a programas externos, URLs ou credenciais.
  test('ca5_external_command_refused_before_spawn_and_no_remote_calls', async () => {
    const mockSpawnImpl = vi.fn()

    // Exemplo [CA5]: argumento gh pr list no executor injetado -> recusado antes do spawn
    await expect(
      runParity({
        repoDir: ROOT,
        manifestPath: MANIFEST_PATH,
        extraArgs: ['gh', 'pr', 'list'],
        spawnImpl: mockSpawnImpl,
      }),
    ).rejects.toMatchObject({
      code: 'parity_external_command_refused',
      exitCode: 2,
    })
    expect(mockSpawnImpl).not.toHaveBeenCalled()

    // Teste com outros comandos externos proibidos: claude, codex, url
    await expect(
      runParity({
        repoDir: ROOT,
        manifestPath: MANIFEST_PATH,
        extraArgs: ['claude', 'run'],
        spawnImpl: mockSpawnImpl,
      }),
    ).rejects.toMatchObject({
      code: 'parity_external_command_refused',
      exitCode: 2,
    })
    expect(mockSpawnImpl).not.toHaveBeenCalled()

    await expect(
      runParity({
        repoDir: ROOT,
        manifestPath: MANIFEST_PATH,
        extraArgs: ['https://example.com/api'],
        spawnImpl: mockSpawnImpl,
      }),
    ).rejects.toMatchObject({
      code: 'parity_external_command_refused',
      exitCode: 2,
    })
    expect(mockSpawnImpl).not.toHaveBeenCalled()
  })
})
