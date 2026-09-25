import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { CATALOG, EFFORTS, PLANS } from '../src/models/catalog.ts'
import type { Effort, Family } from '../src/models/catalog.ts'
import { buildChains } from '../src/models/chains.ts'

describe('catálogo de modelos e planos atualizados (S2)', () => {
  test('C2.1: combinações Fable 5.1 low e max, Opus 5 xhigh, Sonnet 5 de low a max, GPT-6 Astra low e GPT-6 Luna low existem com nota, custo e tempo positivos e iguais aos do texto colado', () => {
    const EXPECTED_NEW: Array<{
      family: Family
      model: string
      label: string
      effort: Effort
      intelligence: number
      costPerTask: number
      seconds: number
    }> = [
      { family: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1', effort: 'low', intelligence: 47, costPerTask: 2.37, seconds: 15.55 },
      { family: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1', effort: 'max', intelligence: 53, costPerTask: 7.63, seconds: 268.76 },
      { family: 'claude', model: 'claude-opus-5', label: 'Opus 5', effort: 'xhigh', intelligence: 50, costPerTask: 4.88, seconds: 35.62 },
      { family: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'low', intelligence: 24, costPerTask: 0.51, seconds: 9.50 },
      { family: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'medium', intelligence: 28, costPerTask: 1.00, seconds: 10.14 },
      { family: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'high', intelligence: 32, costPerTask: 1.79, seconds: 16.15 },
      { family: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'xhigh', intelligence: 34, costPerTask: 2.87, seconds: 24.33 },
      { family: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'max', intelligence: 38, costPerTask: 5.09, seconds: 156.32 },
      { family: 'codex', model: 'gpt-6-astra', label: 'GPT-6 Astra', effort: 'low', intelligence: 46, costPerTask: 0.82, seconds: 13.90 },
      { family: 'codex', model: 'gpt-6-luna', label: 'GPT-6 Luna', effort: 'low', intelligence: 21, costPerTask: 0.0045, seconds: 6.10 },
    ]

    for (const exp of EXPECTED_NEW) {
      const found = CATALOG.find((e) => e.model === exp.model && e.effort === exp.effort)
      expect(found, `combinação ausente no catálogo: ${exp.model}(${exp.effort})`).toBeDefined()
      expect(found?.intelligence).toBe(exp.intelligence)
      expect(found?.costPerTask).toBe(exp.costPerTask)
      expect(found?.seconds).toBe(exp.seconds)
      expect(found?.family).toBe(exp.family)
      expect(found?.label).toBe(exp.label)
      expect(found?.intelligence).toBeGreaterThan(0)
      expect(found?.costPerTask).toBeGreaterThan(0)
      expect(found?.seconds).toBeGreaterThan(0)
    }
  })

  test('C2.2: tempo do Opus 5.5 em esforço alto vale 40,65 segundos, e não mais 18,6', () => {
    const opusHigh = CATALOG.find((e) => e.model === 'claude-opus-5-5' && e.effort === 'high')
    expect(opusHigh).toBeDefined()
    expect(opusHigh?.seconds).toBe(40.65)
    expect(opusHigh?.seconds).not.toBe(18.6)
  })

  test('C2.3: todas as combinações que existiam antes continuam presentes, e não há linha do Opus 4.7 nem de modo sem raciocínio', () => {
    const BASELINE_COMBINATIONS = [
      { model: 'claude-opus-5-5', effort: 'max' },
      { model: 'claude-opus-5-5', effort: 'xhigh' },
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-opus-5-5', effort: 'low' },
      { model: 'claude-fable-5-1', effort: 'xhigh' },
      { model: 'claude-fable-5-1', effort: 'high' },
      { model: 'claude-fable-5-1', effort: 'medium' },
      { model: 'claude-opus-5', effort: 'high' },
      { model: 'claude-opus-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' },
      { model: 'claude-haiku-4-5', effort: 'high' },
      { model: 'gpt-6-astra', effort: 'max' },
      { model: 'gpt-6-astra', effort: 'xhigh' },
      { model: 'gpt-6-astra', effort: 'high' },
      { model: 'gpt-6-astra', effort: 'medium' },
      { model: 'gpt-6-sol', effort: 'max' },
      { model: 'gpt-6-sol', effort: 'xhigh' },
      { model: 'gpt-6-sol', effort: 'high' },
      { model: 'gpt-6-sol', effort: 'medium' },
      { model: 'gpt-6-sol', effort: 'low' },
      { model: 'gpt-6-luna', effort: 'max' },
      { model: 'gpt-6-luna', effort: 'xhigh' },
      { model: 'gpt-6-luna', effort: 'high' },
      { model: 'gpt-6-luna', effort: 'medium' },
      { model: 'gpt-5.6-sol', effort: 'xhigh' },
      { model: 'gpt-5.6-sol', effort: 'high' },
      { model: 'gpt-5.6-sol', effort: 'medium' },
      { model: 'gpt-5.6-terra', effort: 'xhigh' },
      { model: 'gpt-5.6-terra', effort: 'high' },
      { model: 'gpt-5.6-terra', effort: 'medium' },
      { model: 'gpt-5.6-luna', effort: 'high' },
      { model: 'gemini-3.8-flash', effort: 'high' },
      { model: 'gemini-3.8-flash', effort: 'medium' },
      { model: 'gemini-3.1-pro', effort: 'high' },
    ]

    for (const base of BASELINE_COMBINATIONS) {
      const exists = CATALOG.some((e) => e.model === base.model && e.effort === base.effort)
      expect(exists, `combinação pré-existente deve continuar presente: ${base.model}(${base.effort})`).toBe(true)
    }

    const hasOpus47 = CATALOG.some((e) => e.model.includes('4-7') || e.label.includes('4.7'))
    expect(hasOpus47, 'não pode conter linha do Opus 4.7').toBe(false)

    for (const entry of CATALOG) {
      expect(EFFORTS).toContain(entry.effort)
      expect(entry.label.toLowerCase()).not.toContain('non-reasoning')
    }
  })

  test('C2.4: empresas, planos, tamanhos de cota e modelos liberados por plano continuam iguais', () => {
    expect(Object.keys(PLANS).sort()).toEqual(['agy', 'claude', 'codex'])

    expect(PLANS.claude.label).toBe('Claude')
    expect(PLANS.claude.tiers).toEqual([
      { id: 'none', label: 'Não tenho', size: 0 },
      { id: 'pro', label: 'Pro', size: 1, models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'] },
      { id: 'max5', label: 'Max 5x', size: 5 },
      { id: 'max20', label: 'Max 20x', size: 20 },
      { id: 'api', label: 'API', size: 20, api: true },
    ])

    expect(PLANS.codex.label).toBe('ChatGPT')
    expect(PLANS.codex.tiers).toEqual([
      { id: 'none', label: 'Não tenho', size: 0 },
      { id: 'plus', label: 'Plus', size: 1, models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
      { id: 'pro5', label: 'Pro 5x', size: 5 },
      { id: 'pro20', label: 'Pro 20x', size: 20 },
      { id: 'api', label: 'API', size: 20, api: true },
    ])

    expect(PLANS.agy.label).toBe('Google')
    expect(PLANS.agy.tiers).toEqual([
      { id: 'none', label: 'Não tenho', size: 0 },
      { id: 'free', label: 'Gratuito', size: 0.5, models: ['gemini-3.8-flash'] },
      { id: 'ai_pro', label: 'AI Pro', size: 2 },
      { id: 'ultra750', label: 'AI Ultra R$ 750', size: 10 },
      { id: 'ultra1000', label: 'AI Ultra R$ 1.000', size: 13 },
    ])
  })

  test('C2.5: tabela nova e planos Max 20x do Claude e Pro 20x do ChatGPT, sem esforço fixado: nenhuma posição usa esforço máximo, nem nas linhas máximas novas do Fable 5.1 e do Sonnet 5', () => {
    const fableMax = CATALOG.find((e) => e.model === 'claude-fable-5-1' && e.effort === 'max')
    expect(fableMax, 'linha máxima nova do Fable 5.1 deve existir no catálogo').toBeDefined()
    const sonnetMax = CATALOG.find((e) => e.model === 'claude-sonnet-5' && e.effort === 'max')
    expect(sonnetMax, 'linha máxima nova do Sonnet 5 deve existir no catálogo').toBeDefined()

    const NOW = Date.parse('2026-09-21T00:00:00Z')
    const { chains } = buildChains({ plans: { claude: 'max20', codex: 'pro20' }, now: NOW })
    for (const [role, chain] of Object.entries(chains)) {
      for (const slot of chain) {
        expect(slot.effort, `papel ${role} não pode usar esforço máximo: ${slot.model}`).not.toBe('max')
        expect(`${slot.model}(${slot.effort})`).not.toBe('claude-fable-5-1(max)')
        expect(`${slot.model}(${slot.effort})`).not.toBe('claude-sonnet-5(max)')
      }
    }
  })

  test('C2.6: comentário do topo cita a data de 25/09/2026, as colunas usadas para tempo e custo, e que a consulta ao site foi bloqueada', () => {
    const catalogPath = path.resolve(__dirname, '../src/models/catalog.ts')
    const content = fs.readFileSync(catalogPath, 'utf8')
    const topComment = content.slice(0, content.indexOf('export type Family'))

    expect(topComment).toContain('25/09/2026')
    expect(topComment).toMatch(/Total Response/i)
    expect(topComment).toMatch(/Cost per Task/i)
    expect(topComment).toMatch(/bloquead/i)
  })
})
