import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

// Registro das coleções famosas em `docs/catalog-sources.md` §1.2 e o ADR 0042 que emenda os ADRs 0039 e 0009.
// Tudo lido do disco, sem rede.

const ROOT = path.resolve(import.meta.dirname, '..')
const CURATED = path.join(ROOT, 'docs', 'catalog', 'fontes-curadas.json')
const REGISTRY = path.join(ROOT, 'docs', 'catalog-sources.md')
const ADR_DIR = path.join(ROOT, 'docs', 'adr')

type Curated = { name: string; url: string; commit: string; license: string }

const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// Trecho da seção §1.2 até o próximo título de mesmo nível.
function section12(): string {
  const text = read(REGISTRY)
  const start = text.search(/^## 1\.2\b/m)
  if (start < 0) return ''
  const rest = text.slice(start + 1)
  const end = rest.search(/^## /m)
  return end < 0 ? rest : rest.slice(0, end)
}

function findAdr0042(): string | undefined {
  const file = fs.readdirSync(ADR_DIR).find((f) => /^0042-.*\.md$/.test(f))
  return file ? path.join(ADR_DIR, file) : undefined
}

describe('registro de fontes do catálogo (C3.1)', () => {
  test('toda fonte curada aparece em §1.2 com o mesmo commit abreviado e a mesma licença', () => {
    const curated = JSON.parse(read(CURATED)) as Curated[]
    expect(curated.length).toBeGreaterThan(0)
    const section = section12()
    expect(section, 'docs/catalog-sources.md precisa de uma seção "## 1.2"').not.toBe('')
    const lines = section.split('\n')
    for (const source of curated) {
      const slug = source.url.replace(/^https:\/\/github\.com\//, '')
      const short = source.commit.slice(0, 7)
      const row = lines.find((line) => line.includes(slug) || line.includes(source.name))
      expect(row, `fonte ${source.name} (${slug}) ausente de §1.2`).toBeDefined()
      expect(row, `commit de ${source.name}`).toContain(short)
      expect(row, `licença de ${source.name}`).toMatch(
        new RegExp(`(^|[^\\w.-])${source.license.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w.-]|$)`),
      )
    }
  })

  test('§1.2 traz motivo, sinal da comunidade com data e o que ficou de fora', () => {
    const section = section12()
    expect(section).toMatch(/motivo/i)
    expect(section).toMatch(/estrelas/i)
    expect(section).toMatch(/2026-\d{2}-\d{2}/)
    expect(section).toMatch(/fora/i)
  })
})

describe('ADR 0042 (C3.2)', () => {
  test('existe, está aceito, emenda 0039 e 0009, fala de --sources e diz como reverter', () => {
    const file = findAdr0042()
    expect(file, 'docs/adr/0042-*.md não existe').toBeDefined()
    expect(path.basename(file!)).toBe('0042-colecoes-famosas-no-catalogo.md')
    const text = read(file!)
    expect(text).toMatch(/^\*\*Status:\*\*\s*Aceito/im)
    expect(text).toMatch(/emenda/i)
    expect(text).toMatch(/0039/)
    expect(text).toMatch(/0009/)
    expect(text).toContain('--sources')
    expect(text).toContain('fontes-curadas.json')
    expect(text).toMatch(/revert/i)
  })
})

describe('ADRs emendados intactos (C3.3)', () => {
  const pinned: Record<string, string> = {
    '0009-skill-fabric-catalogo-curado-selecao-12-controles.md':
      'e0be095eff74ab01ff46a332691651a347497f47ab5fa1a33d0db22981f9b531',
    '0039-catalogo-real-e-escolha-de-skills-pelo-plano.md':
      'e0f41857fb8ba0a12ff8120bdfc43e98253ab4ca016b511d8988c523177d55e6',
  }
  for (const [name, digest] of Object.entries(pinned)) {
    test(`${name} não mudou`, () => {
      const sha = createHash('sha256').update(read(path.join(ADR_DIR, name))).digest('hex')
      expect(sha).toBe(digest)
    })
  }
})
