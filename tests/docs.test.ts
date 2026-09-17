import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ADR_0023_PATH = fileURLToPath(new URL('../docs/adr/0023-js-esm-com-jsdoc-e-checkjs.md', import.meta.url))
const ADR_0001_PATH = fileURLToPath(new URL('../docs/adr/0001-typescript-node-monorepo.md', import.meta.url))
const README_PATH = fileURLToPath(new URL('../docs/adr/README.md', import.meta.url))

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
