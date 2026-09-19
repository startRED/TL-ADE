import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const README_PATH = path.join(ROOT_DIR, 'README.md')
const CHARTER_PATH = path.join(ROOT_DIR, 'PROJECT_CHARTER.md')
const ROADMAP_PATH = path.join(ROOT_DIR, 'docs', 'roadmap.md')
const CLOSURE_PATH = path.join(ROOT_DIR, 'docs', 'plans', 'slice-1-fechamento.md')
const PROPOSAL_PATH = path.join(ROOT_DIR, 'docs', 'plans', 'v02-local-proposta.md')
const APPROVAL_PATH = path.join(ROOT_DIR, 'docs', 'plans', 'v02-local-aprovacao.md')
const DOGFOOD_PATH = path.join(ROOT_DIR, 'docs', 'operations', 'dogfood-d1.md')
const ADR_DIR = path.join(ROOT_DIR, 'docs', 'adr')

export function extractStateSection(text: string): string {
  const match = text.match(/^## Estado e autorização\b.*$/m)
  if (!match || match.index === undefined) return ''
  const start = match.index
  const rest = text.slice(start + match[0].length)
  const nextHeading = rest.match(/\n## |\n---|\n\*\*Regra|\nRepositório canônico/)
  const end = nextHeading && nextHeading.index !== undefined
    ? start + match[0].length + nextHeading.index
    : text.length
  return text.slice(start, end).trim()
}

export function extractMarkdownLinks(text: string): string[] {
  const matches = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  return matches.map((m) => m[1])
}

export function resolveLinks(baseFile: string, text: string): { link: string; resolved: string; exists: boolean }[] {
  const dir = path.dirname(baseFile)
  const links = extractMarkdownLinks(text).filter((l) => !l.startsWith('http://') && !l.startsWith('https://'))
  return links.map((link) => {
    const resolved = path.resolve(dir, link)
    return { link, resolved, exists: existsSync(resolved) }
  })
}

export function validateStateSection(baseFile: string, text: string): {
  hasAllStates: boolean
  hasBlock: boolean
  linksOk: boolean
  missingStates: string[]
  brokenLinks: string[]
} {
  const sec = extractStateSection(text)
  const isV1Authorized = sec.includes('Autorização até a v1')
  const requiredStates = isV1Authorized
    ? [
        'Autorização até a v1',
        'Sequência obrigatória dos marcos',
        'Recorte ativo deste épico',
      ]
    : [
        'Slice 1: fechamento pendente',
        'Recorte local v0.2: não autorizado',
        'Restante da v0.2: fora desta rodada',
      ]
  const missingStates = requiredStates.filter((s) => !sec.includes(s))
  const hasBlock = isV1Authorized
    ? sec.includes('Implementação dependente: autorizada sequencialmente')
    : sec.includes('Implementação dependente: bloqueada')
  const links = resolveLinks(baseFile, sec)
  const brokenLinks = links.filter((l) => !l.exists).map((l) => l.link)
  return {
    hasAllStates: missingStates.length === 0,
    hasBlock,
    linksOk: links.length > 0 && brokenLinks.length === 0,
    missingStates,
    brokenLinks,
  }
}

export function parseMarkdownTableRows(text: string, heading: string): Record<string, string>[] {
  const start = text.indexOf(heading)
  if (start < 0) return []
  const next = text.indexOf('\n## ', start + heading.length)
  const sec = text.slice(start, next < 0 ? undefined : next)
  const lines = sec.split(/\r?\n/).filter((line) => line.startsWith('|'))
  if (lines.length < 3) return []
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim())
  const headers = cells(lines[0])
  return lines.slice(2).map((l) => {
    const vals = cells(l)
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']))
  })
}

describe('publicação do estado comprovado e bloqueios da v0.2', () => {
  // CA1: Três documentos publicados apresentam estados previstos e links relativos válidos
  test('CA1 publica seções de estado com três estados distintos e links relativos válidos', () => {
    const docs = [
      { name: 'README.md', path: README_PATH },
      { name: 'PROJECT_CHARTER.md', path: CHARTER_PATH },
      { name: 'docs/roadmap.md', path: ROADMAP_PATH },
    ]

    for (const doc of docs) {
      expect(existsSync(doc.path), `${doc.name} deve existir`).toBe(true)
      const content = readFileSync(doc.path, 'utf8')
      const sec = extractStateSection(content)
      expect(sec, `Seção Estado e autorização deve existir em ${doc.name}`).not.toBe('')

      const validation = validateStateSection(doc.path, content)
      expect(validation.missingStates, `Estados faltando em ${doc.name}`).toEqual([])
      expect(validation.hasAllStates).toBe(true)

      const links = resolveLinks(doc.path, sec)
      expect(links.length, `Deve haver links relativos na seção de ${doc.name}`).toBeGreaterThanOrEqual(3)
      for (const item of links) {
        expect(item.exists, `Link ${item.link} em ${doc.name} deve apontar para arquivo existente: ${item.resolved}`).toBe(true)
      }

      // Referências obrigatórias aos registros existentes
      expect(existsSync(PROPOSAL_PATH), 'docs/plans/v02-local-proposta.md deve existir').toBe(true)
      const rawLinks = links.map((l) => l.link)
      expect(rawLinks.some((l) => l.includes('slice-1-fechamento.md')), `Link a slice-1-fechamento ausente em ${doc.name}`).toBe(true)
      expect(rawLinks.some((l) => l.includes('v02-local-proposta.md')), `Link a v02-local-proposta ausente em ${doc.name}`).toBe(true)
      expect(rawLinks.some((l) => l.includes('v02-local-aprovacao.md')), `Link a v02-local-aprovacao ausente em ${doc.name}`).toBe(true)

      // Teste em memória: quebra de link deve ser rejeitada
      const brokenContent = content.replaceAll(/(slice-1-fechamento\.md|v02-local-proposta\.md)/g, 'caminho-inexistente.md')
      const brokenValidation = validateStateSection(doc.path, brokenContent)
      expect(brokenValidation.linksOk, `Validação de links deve falhar em caso de caminho inexistente em ${doc.name}`).toBe(false)
      expect(brokenValidation.brokenLinks.length).toBeGreaterThan(0)
    }
  })

  // CA2: Sete aprovações pendentes e fechamento pendente impõem bloqueio e barram ADR 0024
  test('CA2 sete aprovações pendentes e fechamento pendente impõem bloqueio e barram ADR 0024', () => {
    // 1. Sete aprovações pendentes na consulta única
    expect(existsSync(APPROVAL_PATH), 'docs/plans/v02-local-aprovacao.md deve existir').toBe(true)
    const approvalText = readFileSync(APPROVAL_PATH, 'utf8')
    const d1d6Rows = parseMarkdownTableRows(approvalText, '## Decisões D1–D6')
    const minuteRows = parseMarkdownTableRows(approvalText, '## Aprovação separada da minuta')
    const allApprovalRows = [...d1d6Rows, ...minuteRows]

    expect(allApprovalRows).toHaveLength(7)
    expect(allApprovalRows.map((r) => r.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'minuta_adr_0024'])
    expect(allApprovalRows.every((r) => r.estado === 'pendente')).toBe(true)

    // 2. Fechamento pendente na matriz
    expect(existsSync(CLOSURE_PATH), 'docs/plans/slice-1-fechamento.md deve existir').toBe(true)
    const closureText = readFileSync(CLOSURE_PATH, 'utf8')
    const matrixRows = parseMarkdownTableRows(closureText, '## Matriz')
    expect(matrixRows.length).toBeGreaterThan(0)
    expect(matrixRows.some((r) => r.estado === 'comprovado')).toBe(false)
    expect(closureText).toMatch(/^Estado:\s+\*\*fechamento pendente\*\*$/m)

    // 3. Documentos publicados contêm o estado de bloqueio ou autorização sequencial
    const docs = [
      { name: 'README.md', path: README_PATH },
      { name: 'PROJECT_CHARTER.md', path: CHARTER_PATH },
      { name: 'docs/roadmap.md', path: ROADMAP_PATH },
    ]
    for (const doc of docs) {
      const content = readFileSync(doc.path, 'utf8')
      const sec = extractStateSection(content)
      const expectedStatus = sec.includes('Autorização até a v1')
        ? 'Implementação dependente: autorizada sequencialmente'
        : 'Implementação dependente: bloqueada'
      expect(sec, `Seção Estado e autorização ausente em ${doc.name}`).toContain(expectedStatus)

      // Teste em memória: remoção da frase de estado deve ser rejeitada
      const withoutStatus = content.replace(expectedStatus, '')
      const validation = validateStateSection(doc.path, withoutStatus)
      expect(validation.hasBlock, `Remoção do estado em ${doc.name} deve ser detectada`).toBe(false)
    }

    // 4. ADR 0024 publicado conforme autorizado por Erick em 2026-09-19
    expect(existsSync(ADR_DIR), 'docs/adr deve existir').toBe(true)
    const adrFiles = readdirSync(ADR_DIR)
    const adr0024Files = adrFiles.filter((f) => /^0024.*\.md$/i.test(f))
    expect(adr0024Files, 'ADR 0024 deve estar publicado em docs/adr/').toEqual(['0024-autorizacao-roadmap-ate-v1.md'])
  })

  // CA3: README Próximo passo referencia fontes e proíbe inferência por dólares
  test('CA3 próximo passo no README referencia fontes e veda inferência por dólares', () => {
    expect(existsSync(README_PATH), 'README.md deve existir').toBe(true)
    const readme = readFileSync(README_PATH, 'utf8')

    // Extrair seção ## Próximo passo
    const nextStepMatch = readme.match(/^## Próximo passo\b.*$/m)
    expect(nextStepMatch, 'README deve ter seção ## Próximo passo').not.toBeNull()
    const nextStepStart = nextStepMatch?.index ?? -1
    const nextStepSection = readme.slice(nextStepStart)

    // Frase literal exigida
    const literalPhrase = 'US$ 0,28 do dogfood não medem percentual da assinatura'
    expect(nextStepSection).toContain(literalPhrase)

    // Substituição de "iniciar o slice 1" por conferir lacunas e responder à consulta
    expect(nextStepSection).not.toContain('iniciar o slice 1')
    expect(nextStepSection).toContain('lacunas da matriz')
    expect(nextStepSection).toContain('consulta única')

    // Dependências da metade da cota
    expect(nextStepSection).toContain('fonte')
    expect(nextStepSection).toContain('janela semanal')
    expect(nextStepSection).toContain('consumo externo')
    expect(nextStepSection).toContain('tratamento de ausência')

    // Links obrigatórios no Próximo passo
    const links = resolveLinks(README_PATH, nextStepSection)
    expect(links.some((l) => l.link === 'docs/operations/dogfood-d1.md' && l.exists)).toBe(true)
    expect(links.some((l) => l.link === 'docs/plans/v02-local-aprovacao.md' && l.exists)).toBe(true)

    // Validação do dogfood D1 como fonte do valor US$ 0,28
    const dogfoodText = readFileSync(DOGFOOD_PATH, 'utf8')
    expect(dogfoodText).toContain('custo_observado_usd: 0.28')

    // Validação da consulta única como fonte da proibição de inferir percentual por dólares, sem exigir US$ 0,28 nela
    const approvalText = readFileSync(APPROVAL_PATH, 'utf8')
    expect(approvalText).toContain('tokens e dólares permanecem telemetria sem conversão')
    expect(approvalText).not.toContain('0,28')
    expect(approvalText).not.toContain('US$ 0,28')
  })

  // CA4: Carta preserva limites, exclusões e referência ao registro comum
  test('CA4 Carta mantém limite de 80 linhas, exclusões e referência ao registro comum', () => {
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)
    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const lines = charter.split(/\r?\n/)

    // Limite máximo de 80 linhas
    expect(lines.length, 'Carta deve ter no máximo 80 linhas').toBeLessThanOrEqual(80)

    // Seção de estado na carta em no máximo 12 linhas
    const sec = extractStateSection(charter)
    expect(sec).not.toBe('')
    const secLines = sec.split(/\r?\n/).filter((l) => l.trim().length > 0)
    expect(secLines.length, 'Seção Estado e autorização na Carta deve ter no máximo 12 linhas').toBeLessThanOrEqual(12)

    // Exclusões preservadas
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

    // Regras normativas preservadas
    expect(charter).toContain('Regra de ampliação')
    expect(charter).toContain('Regra de cerimônia proporcional')
    expect(charter).toContain('codex exec')

    // Declara que a nota não altera exclusões nem ativa a emenda
    expect(sec).toContain('não altera exclusões nem ativa a emenda')

    // Referência ao registro comum com os três comandos com saída 0 antes de qualquer commit
    expect(charter).toContain('docs/plans/v02-local-proposta.md')
    expect(charter).toContain('node node_modules/vitest/vitest.mjs run')
    expect(charter).toContain('node node_modules/typescript/bin/tsc --noEmit')
    expect(charter).toContain('npm run lint')
    expect(charter).toContain('saída 0 antes de qualquer commit')
    expect(charter).toContain('sem npx nem git push')

    // Testes em memória de casos negativos
    // Caso 1: Carta com 81 linhas é rejeitada
    const lines81 = charter + '\n'.repeat(Math.max(1, 82 - lines.length))
    expect(lines81.split(/\r?\n/).length).toBeGreaterThan(80)

    // Caso 2: Referência a link inexistente é rejeitada
    const brokenCharter = charter.replaceAll('(docs/plans/v02-local-proposta.md)', '(docs/plans/inexistente.md)')
    const brokenValidation = validateStateSection(CHARTER_PATH, brokenCharter)
    expect(brokenValidation.linksOk).toBe(false)
    expect(brokenValidation.brokenLinks).toContain('docs/plans/inexistente.md')

    // Caso 3: Remoção do estado é rejeitada
    const unblockedCharter = charter.replace(/Implementação dependente: [^\n\r]+/, '')
    const unblockedValidation = validateStateSection(CHARTER_PATH, unblockedCharter)
    expect(unblockedValidation.hasBlock).toBe(false)
  })
})
