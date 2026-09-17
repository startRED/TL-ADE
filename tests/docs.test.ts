import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ADR_0023_PATH = fileURLToPath(new URL('../docs/adr/0023-js-esm-com-jsdoc-e-checkjs.md', import.meta.url))
const ADR_0001_PATH = fileURLToPath(new URL('../docs/adr/0001-typescript-node-monorepo.md', import.meta.url))
const README_PATH = fileURLToPath(new URL('../docs/adr/README.md', import.meta.url))
const CHARTER_PATH = fileURLToPath(new URL('../PROJECT_CHARTER.md', import.meta.url))

describe('ADR 0023', () => {
  // AC1: Formato fixo com status proposto e ordem das 7 seções
  test('adr_0023_follows_fixed_format_with_proposed_status', () => {
    expect(existsSync(ADR_0023_PATH), 'docs/adr/0023-js-esm-com-jsdoc-e-checkjs.md deve existir').toBe(true)

    const content = readFileSync(ADR_0023_PATH, 'utf8')
    const lines = content.split(/\r?\n/)

    expect(lines[0].startsWith('# ADR 0023 —'), 'Título deve começar com # ADR 0023 —').toBe(true)
    expect(lines[2], 'Linha 3 deve conter o status proposto').toBe('**Status:** proposto, pendente de confirmação do Erick')

    const sections = [
      '## Contexto',
      '## Decisão',
      '## Evidência',
      '## Trade-offs',
      '## Alternativas rejeitadas',
      '## Como reverter',
      '## Consequências para outros documentos',
    ]

    let lastIndex = -1
    for (const section of sections) {
      const index = content.indexOf(section)
      expect(index, `Seção ausente: ${section}`).toBeGreaterThan(-1)
      expect(index, `Seção fora de ordem: ${section}`).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })

  // AC2: Termos normativos da decisão no texto do ADR
  test('adr_0023_states_js_esm_jsdoc_checkjs_decision', () => {
    expect(existsSync(ADR_0023_PATH), 'docs/adr/0023-js-esm-com-jsdoc-e-checkjs.md deve existir').toBe(true)

    const content = readFileSync(ADR_0023_PATH, 'utf8')
    const requiredTerms = [
      'checkJs',
      'allowJs',
      'JSDoc',
      'tsc --noEmit',
      'ADR 0001',
      'src/**/*.js',
    ]

    for (const term of requiredTerms) {
      expect(content, `Termo ausente: ${term}`).toContain(term)
    }
  })

  // AC3: Linha de índice e linha do mapa listando 0023 em docs/adr/README.md
  test('adr_index_and_map_list_0023', () => {
    expect(existsSync(README_PATH), 'docs/adr/README.md deve existir').toBe(true)

    const readme = readFileSync(README_PATH, 'utf8')
    expect(readme).toContain('(0023-js-esm-com-jsdoc-e-checkjs.md)')

    const lines = readme.split(/\r?\n/)
    const mapLine = lines.find((line) => line.includes('Stack e repositório'))
    expect(mapLine, 'Linha "Stack e repositório" deve existir no mapa').toBeDefined()
    expect(mapLine).toContain('0001, 0022, 0023')
  })

  // AC4: ADR 0001 não é editado (não contém 0023 e mantém status aceito)
  test('adr_0001_is_not_edited', () => {
    expect(existsSync(ADR_0001_PATH), 'docs/adr/0001-typescript-node-monorepo.md deve existir').toBe(true)

    const content = readFileSync(ADR_0001_PATH, 'utf8')
    expect(content).not.toContain('0023')
    expect(content).toContain('**Status:** aceito 2026-09-17')
  })
})

describe('PROJECT_CHARTER.md slice 1', () => {
  // AC1: Módulos do Slice 1 e nenhum caminho src/... terminando em .ts
  test('project_charter_lists_slice_1_modules_and_forbids_ts', () => {
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const modules = [
      'src/journal',
      'src/step',
      'src/lease',
      'src/git',
      'src/runner',
      'src/contain',
      'src/gates',
      'src/evals',
      'src/pack',
      'src/adapters/claude',
      'src/adapters/fake',
      'src/cli',
      'src/engine.js',
      'src/schema',
    ]

    for (const mod of modules) {
      expect(charter, `Módulo ausente: ${mod}`).toContain(mod)
    }

    expect(charter, 'Nenhum caminho src/... pode terminar em .ts').not.toMatch(/src\/[\w/.-]*\.ts\b/)
  })

  // AC2: Lista de exclusões do Slice 1
  test('project_charter_lists_slice_1_exclusions', () => {
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const exclusions = [
      'Fora do slice 1',
      'Intent Compiler',
      'Skill Fabric',
      'FQE',
      'painel',
      'PTY',
      'push/PR/merge',
      'agy',
      'SQLite',
      'Playwright',
      'Fastify',
      'WebSocket',
    ]

    for (const item of exclusions) {
      expect(charter, `Exclusão ausente: ${item}`).toContain(item)
    }
  })

  // AC3: Regras normativas e limite de 80 linhas
  test('project_charter_declares_rules_and_stays_under_80_lines', () => {
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const rules = [
      'codex exec',
      'Regra de ampliação',
      'cerimônia proporcional',
    ]

    for (const rule of rules) {
      expect(charter, `Regra ausente: ${rule}`).toContain(rule)
    }

    const lines = charter.split(/\r?\n/)
    expect(lines.length, 'PROJECT_CHARTER.md deve ter no máximo 80 linhas').toBeLessThanOrEqual(80)
  })

  // Cobertura completa dos três primeiros critérios de aceite
  test('project_charter_describes_full_slice_1_scope', () => {
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')

    // AC1: Módulos do Slice 1 e nenhum caminho src/... terminando em .ts
    const modules = [
      'src/journal',
      'src/step',
      'src/lease',
      'src/git',
      'src/runner',
      'src/contain',
      'src/gates',
      'src/evals',
      'src/pack',
      'src/adapters/claude',
      'src/adapters/fake',
      'src/cli',
      'src/engine.js',
      'src/schema',
    ]
    for (const mod of modules) {
      expect(charter, `Módulo ausente: ${mod}`).toContain(mod)
    }
    expect(charter, 'Nenhum caminho src/... pode terminar em .ts').not.toMatch(/src\/[\w/.-]*\.ts\b/)

    // AC2: Lista de exclusões do Slice 1
    const exclusions = [
      'Fora do slice 1',
      'Intent Compiler',
      'Skill Fabric',
      'FQE',
      'painel',
      'PTY',
      'push/PR/merge',
      'agy',
      'SQLite',
      'Playwright',
      'Fastify',
      'WebSocket',
    ]
    for (const item of exclusions) {
      expect(charter, `Exclusão ausente: ${item}`).toContain(item)
    }

    // AC3: Regras e limite de 80 linhas
    const rules = [
      'codex exec',
      'Regra de ampliação',
      'cerimônia proporcional',
    ]
    for (const rule of rules) {
      expect(charter, `Regra ausente: ${rule}`).toContain(rule)
    }

    const lines = charter.split(/\r?\n/)
    expect(lines.length, 'PROJECT_CHARTER.md deve ter no máximo 80 linhas').toBeLessThanOrEqual(80)
  })
})

