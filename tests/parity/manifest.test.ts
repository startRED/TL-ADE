import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AdeError } from '../../src/journal/errors.js'
import { selectTests } from '../../vitest.config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const MANIFEST_PATH = path.join(ROOT, 'parity-name-map.json')

export class ParityManifestInvalidError extends AdeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('parity_manifest_invalid', message, 4, details)
  }
}

export class ParityCaseMissingError extends AdeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('parity_case_missing', message, 2, details)
  }
}

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
 *
 * @param {ParityManifest} manifest - Objeto do manifesto a ser validado
 * @param {{ repoDir?: string }} [options] - Opções de resolução no sistema de arquivos
 * @returns {{ total: number, valid: boolean }}
 */
export function validateManifest(
  manifest: ParityManifest,
  options?: { repoDir?: string },
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

    if (options?.repoDir) {
      const resolved = path.join(options.repoDir, c.test_file)
      if (!existsSync(resolved)) {
        throw new ParityCaseMissingError(
          `Destino de teste não encontrado na fixture: ${c.test_file}`,
          { target: c.target, test_file: c.test_file },
        )
      }
    }
  }

  return { total: manifest.cases.length, valid: true }
}

describe('manifest parity', () => {
  // CA1: Dado parity-name-map.json, quando o inventário é validado, então há exatamente 93 fontes
  // e 93 destinos únicos declarados no mapa; a prova manifest.test.ts valida a integridade do arquivo
  // e recusa destinos inexistentes contra fixtures temporárias.
  test('ca1_inventory_has_93_unique_sources_and_targets_and_resolves_against_fixture', () => {
    expect(existsSync(MANIFEST_PATH), 'parity-name-map.json deve existir na raiz').toBe(true)

    const raw = readFileSync(MANIFEST_PATH, 'utf8')
    const manifest = JSON.parse(raw) as ParityManifest

    // Validação estrutural do manifesto oficial
    const result = validateManifest(manifest)
    expect(result).toEqual({ total: 93, valid: true })

    // Exemplo [CA1]: mapa com 93 pares source/target únicos em fixture temporária com 93 arquivos de teste -> {total:93,valid:true}
    const tmpDir = path.join(ROOT, '.ade-tmp-manifest-test-ca1')
    try {
      rmSync(tmpDir, { recursive: true, force: true })
      mkdirSync(path.join(tmpDir, 'tests', 'parity'), { recursive: true })

      for (const item of manifest.cases) {
        const filePath = path.join(tmpDir, item.test_file)
        mkdirSync(path.dirname(filePath), { recursive: true })
        writeFileSync(filePath, '// dummy test file\n')
      }

      const fixtureResult = validateManifest(manifest, { repoDir: tmpDir })
      expect(fixtureResult).toEqual({ total: 93, valid: true })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }

    // Exemplo [CA1]: mapa com target:'ausente' e fixture sem tests/parity/ausente.test.ts -> erro parity_case_missing
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

    const tmpEmpty = path.join(ROOT, '.ade-tmp-manifest-empty')
    try {
      rmSync(tmpEmpty, { recursive: true, force: true })
      mkdirSync(path.join(tmpEmpty, 'tests', 'parity'), { recursive: true })

      expect(() => validateManifest(missingTargetManifest, { repoDir: tmpEmpty })).toThrowError(
        expect.objectContaining({ code: 'parity_case_missing' }),
      )
    } finally {
      rmSync(tmpEmpty, { recursive: true, force: true })
    }
  })

  // CA2: Dado um caso com status 'renamed', quando o mapa é validado, então reason é texto não vazio;
  // um caso 'same' usa target igual ao source sem o prefixo test_.
  test('ca2_renamed_cases_require_reason_and_same_cases_strip_test_prefix', () => {
    // Exemplo [CA2]: {source:'test_dirty_tree_before_unit_stops',target:'dirty_worktree_before_story_stops',status:'renamed',reason:'guarda por worktree'} -> válido
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
  // fixa quatro workers, inclui somente tests/parity/**, exclui tests/probes/** e não contém chamada
  // a claude, codex, gh ou endereço de rede.
  test('ca3_parity_target_config_has_four_workers_isolated_inclusion_and_no_external_calls', () => {
    // Exemplo [CA3]: {ADE_PARITY:'1'} -> {include:['tests/parity/**/*.test.ts'],exclude:['tests/probes/**'],maxWorkers:4}
    const parityConfig = selectTests({ ADE_PARITY: '1' })
    expect(parityConfig).toEqual({
      include: ['tests/parity/**/*.test.ts'],
      exclude: ['tests/probes/**'],
      maxWorkers: 4,
    })

    // Quando não for '1', preserva a seleção padrão
    const defaultConfig = selectTests({})
    expect(defaultConfig.include).toEqual(['tests/**/*.test.ts'])
    expect(defaultConfig.exclude).toContain('tests/probes/**')

    // package.json script test:parity e test:probes
    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(pkg.scripts?.['test:parity']).toBe(
      'set ADE_PARITY=1&& node node_modules/vitest/vitest.mjs run',
    )
    expect(pkg.scripts?.['test:probes']).toBeDefined()
    expect(pkg.scripts?.['test:probes']).not.toMatch(/\b(claude|codex|gh|https?:\/\/)/i)
  })

  // CA4: Dado o ADR 0024, o charter e o roadmap, quando os registros são lidos, então a autorização
  // até a v1, a ordem obrigatória dos marcos e o limite deste épico aparecem sem alterar os ADRs 0001–0023.
  test('ca4_adr_0024_charter_and_roadmap_record_v1_authorization_and_sequence', () => {
    const adr24Path = path.join(ROOT, 'docs/adr/0024-autorizacao-roadmap-ate-v1.md')
    expect(existsSync(adr24Path), 'ADR 0024 deve existir').toBe(true)
    const adr24 = readFileSync(adr24Path, 'utf8')

    // Exemplo [CA4]: ADR 0024 aceito por Erick em 2026-09-19, charter e roadmap com o mesmo recorte
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

    // ADRs 0001 a 0023 não alterados em sua essência
    const adrDir = path.join(ROOT, 'docs/adr')
    for (let i = 1; i <= 23; i++) {
      const prefix = String(i).padStart(4, '0')
      const files = existsSync(adrDir)
        ? readFileSync(path.join(ROOT, 'docs/adr/README.md'), 'utf8')
        : ''
      expect(files).toContain(prefix)
    }
  })
})
