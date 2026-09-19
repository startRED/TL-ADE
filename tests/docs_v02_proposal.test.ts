import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const PROPOSAL_PATH = fileURLToPath(new URL('../docs/plans/v02-local-proposta.md', import.meta.url))
const DECISION_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']

function proposal(): string {
  return existsSync(PROPOSAL_PATH) ? readFileSync(PROPOSAL_PATH, 'utf8') : ''
}

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  return from < 0 ? '' : text.slice(from, to < 0 ? undefined : to)
}

function localScopeIsValid(text: string): boolean {
  const scope = section(text, '## Escopo', '\n## ')
  return [
    'revisão integrada local',
    'Slice 1',
    'v0.2 completa',
    'push: fora do recorte',
    'PR: fora do recorte',
    'merge remoto: fora do recorte',
    'D2 remoto: fora do recorte',
  ].every((term) => scope.includes(term)) && !/push:\s*autorizado/i.test(scope)
}

function decisionBlocks(text: string): Map<string, string> {
  const decisions = section(text, '## Decisões D1–D6', '\n## Minuta de ADR')
  const matches = [...decisions.matchAll(/^### (D[1-6])\b/gm)]
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? decisions.length
    return [match[1], decisions.slice(match.index, end)]
  }))
}

function decisionsAreComplete(text: string): boolean {
  const blocks = decisionBlocks(text)
  return blocks.size === 6 && DECISION_IDS.every((id) => {
    const block = blocks.get(id) ?? ''
    return [
      '**Recomendação:**',
      '**Alternativa:**',
      '**Motivo:**',
      '**Risco:**',
      '**Alterações dependentes:**',
      '**Dependências:**',
      '**Estado inicial:** pendente',
    ].every((field) => block.includes(field))
  })
}

function remainingQuota(source: { initial: number, growth: number } | null): number | string {
  if (source === null) return 'cota indisponível; execução paga bloqueada'
  return Math.max(0, 50 - source.initial - source.growth)
}

function commonRecordIsValid(text: string): boolean {
  const common = section(text, '## Restrições comuns', '\n## ')
  const required = [
    'partes próximas de 300 linhas com prova própria',
    'eval antes do código',
    '`src/**/*.js` ESM com JSDoc',
    '`tests/**/*.test.ts`',
    'português',
    '`strict`',
    '`ajv` e `canonicalize`',
    'CLIs instaladas, sem APIs HTTP de modelos',
    '`AdeError` com `exitCode`',
    'sem `shell` e com `maxBuffer` explícito',
    '`proto/**`',
    'oito `schemas/*.schema.json`',
    '`tests/meta.test.ts`',
    'pacote único',
    'node node_modules/vitest/vitest.mjs run',
    'node node_modules/typescript/bin/tsc --noEmit',
    'npm run lint',
    'saída 0 antes de qualquer commit',
  ]
  return required.every((term) => common.includes(term))
}

describe('proposta de revisão integrada local da v0.2', () => {
  test('CA1 delimita revisão local sem confundir Slice 1, v0.2 completa ou entrega remota', () => {
    const text = proposal()
    expect(existsSync(PROPOSAL_PATH), 'proposta ausente').toBe(true)
    expect(localScopeIsValid(text)).toBe(true)
    expect(localScopeIsValid(text.replace('push: fora do recorte', 'push: autorizado'))).toBe(false)
    expect(text).toContain('revisão Codex')
    expect(text).toContain('resultado validado')
    expect(text).toContain('rework limitado')
    expect(text).toContain('entrega local')
    expect(text).toContain('93/93')
    expect(text).toContain('pré-condições')
    expect(text).toContain('fechamento pendente')
  })

  test('CA2 publica exatamente D1 a D6 com recomendação, alternativa, risco e dependências', () => {
    const text = proposal()
    expect(decisionsAreComplete(text)).toBe(true)
    const withoutD3 = text.replace(/^### D3\b[\s\S]*?(?=^### D4\b)/m, '')
    expect(decisionsAreComplete(withoutD3)).toBe(false)
    expect(text).toContain('critérios aprovados imutáveis')
    expect(text).toContain('sem autoaprovação')
    expect(text).toContain('somente leitura')
    expect(text).toContain('vendor distinto')
    expect(text).toContain('ff-only')
    expect(text).toContain('arquitetura §9.2')
    expect(text).toContain('E64')
  })

  test('CA3 define teto por assinatura e bloqueia fechado quando a fonte não serve', () => {
    const text = proposal()
    expect(remainingQuota({ initial: 40, growth: 10 })).toBe(0)
    expect(remainingQuota(null)).toBe('cota indisponível; execução paga bloqueada')
    expect(text).toContain('teto absoluto de 50% por assinatura')
    expect(text).toContain('40% + 10 pontos percentuais = 50%; restante = 0%')
    expect(text).toContain('cota indisponível; execução paga bloqueada')
    expect(text).toContain('consumo externo')
    expect(text).toContain('nenhuma soma entre assinaturas')
    expect(text).toContain('sem renovação automática')
    expect(text).toContain('tokens e dólares permanecem telemetria sem conversão')
    expect(text).toContain('E69')
    expect(text).toContain('arquitetura §9.8')
    expect(text).toContain('roadmap §2, item 15')
  })

  test('CA4 preserva restrições herdadas, gates e autorização vinculada ao mesmo hash', () => {
    const text = proposal()
    expect(commonRecordIsValid(text)).toBe(true)
    expect(commonRecordIsValid(text.replace('npm run lint', ''))).toBe(false)
    expect(commonRecordIsValid(text.replace('saída 0 antes de qualquer commit', ''))).toBe(false)
    expect(text).toContain('blob UTF-8 integral')
    expect(text).toContain('SHA-256')
    expect(text).toContain('minuta_adr_0024')
    expect(text).toContain('mesmo hash')
    expect(text).toContain('fechamento comprovado do Slice 1')
    expect(text).toContain('CLI, canário, capacidade e fonte de cota')
    expect(text).toContain('despacho pago posterior')
  })
})
