// Catálogo de modelos, planos de cada empresa e o que cada papel precisa (ADR 0033).
// Números da Artificial Analysis colados pelo usuário em 25/09/2026 (a consulta direta às páginas de fornecedores
// artificialanalysis.ai/providers/openai e /providers/anthropic foi bloqueada): intelligence = Intelligence Index,
// costPerTask = coluna 'Cost per Task' (US$ para rodar o índice: quanto a chamada pesa na cota), seconds = coluna
// 'Total Response (s)' (a resposta inteira, pensando junto). Opus 5.5 max não tem tempo no texto: 300 s estimados.
// Modelos fora do texto ficam com os números da leitura de 22/09/2026. Modo sem raciocínio e Opus 4.7 ficam fora.

export type Family = 'claude' | 'codex' | 'agy'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RoleId = 'epics' | 'plan' | 'plan_edit' | 'test' | 'impl_light' | 'impl' | 'impl_hard' | 'fix' | 'checker'

export type ModelEntry = {
  family: Family
  model: string
  label: string
  effort: Effort
  intelligence: number
  costPerTask: number
  seconds: number
}

export type Tier = { id: string; label: string; size: number; models?: string[]; api?: boolean }

export type Role = {
  minIntelligence: number
  speed: number
  volume: number
  writer?: boolean
  ladder?: boolean
  crossFamily?: boolean
  label: string
}

export const FAMILIES: Family[] = ['claude', 'codex', 'agy']
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const entry = (family: Family, model: string, label: string, effort: Effort, intelligence: number, costPerTask: number, seconds: number): ModelEntry =>
  ({ family, model, label, effort, intelligence, costPerTask, seconds })

export const CATALOG: ModelEntry[] = [
  entry('claude', 'claude-opus-5-5', 'Opus 5.5', 'max', 58, 5.98, 300),
  entry('claude', 'claude-opus-5-5', 'Opus 5.5', 'xhigh', 56, 3.46, 152.61),
  entry('claude', 'claude-opus-5-5', 'Opus 5.5', 'high', 54, 1.82, 40.65),
  entry('claude', 'claude-opus-5-5', 'Opus 5.5', 'medium', 51, 1.34, 27.47),
  entry('claude', 'claude-opus-5-5', 'Opus 5.5', 'low', 42, 0.55, 12.19),
  entry('claude', 'claude-fable-5-1', 'Fable 5.1', 'max', 53, 7.63, 268.76),
  entry('claude', 'claude-fable-5-1', 'Fable 5.1', 'xhigh', 53, 5.98, 116.17),
  entry('claude', 'claude-fable-5-1', 'Fable 5.1', 'high', 51, 3.91, 31.34),
  entry('claude', 'claude-fable-5-1', 'Fable 5.1', 'medium', 49, 2.98, 18.61),
  entry('claude', 'claude-fable-5-1', 'Fable 5.1', 'low', 47, 2.37, 15.55),
  entry('claude', 'claude-opus-5', 'Opus 5', 'xhigh', 50, 4.88, 35.62),
  entry('claude', 'claude-opus-5', 'Opus 5', 'high', 48, 3.61, 28.93),
  entry('claude', 'claude-opus-5', 'Opus 5', 'medium', 45, 2.19, 13.6),
  entry('claude', 'claude-sonnet-5', 'Sonnet 5', 'max', 38, 5.09, 156.32),
  entry('claude', 'claude-sonnet-5', 'Sonnet 5', 'xhigh', 34, 2.87, 24.33),
  entry('claude', 'claude-sonnet-5', 'Sonnet 5', 'high', 32, 1.79, 16.15),
  entry('claude', 'claude-sonnet-5', 'Sonnet 5', 'medium', 28, 1, 10.14),
  entry('claude', 'claude-sonnet-5', 'Sonnet 5', 'low', 24, 0.51, 9.5),
  entry('claude', 'claude-haiku-4-5', 'Haiku 4.5', 'high', 17, 0.21, 25.8),
  entry('codex', 'gpt-6-astra', 'GPT-6 Astra', 'max', 53, 3.26, 373.61),
  entry('codex', 'gpt-6-astra', 'GPT-6 Astra', 'xhigh', 52, 2.31, 193.97),
  entry('codex', 'gpt-6-astra', 'GPT-6 Astra', 'high', 51, 1.73, 75.41),
  entry('codex', 'gpt-6-astra', 'GPT-6 Astra', 'medium', 50, 1.54, 16.66),
  entry('codex', 'gpt-6-astra', 'GPT-6 Astra', 'low', 46, 0.82, 13.9),
  // GPT-6 Sol e Luna exigem Codex CLI 0.156+ (a 0.154 recusa na conta do ChatGPT).
  entry('codex', 'gpt-6-sol', 'GPT-6 Sol', 'max', 48, 1.06, 183.65),
  entry('codex', 'gpt-6-sol', 'GPT-6 Sol', 'xhigh', 44, 0.53, 50.23),
  entry('codex', 'gpt-6-sol', 'GPT-6 Sol', 'high', 43, 0.37, 17.9),
  entry('codex', 'gpt-6-sol', 'GPT-6 Sol', 'medium', 40, 0.25, 6.34),
  entry('codex', 'gpt-6-sol', 'GPT-6 Sol', 'low', 34, 0.13, 7.36),
  entry('codex', 'gpt-6-luna', 'GPT-6 Luna', 'max', 37, 0.07, 112.73),
  entry('codex', 'gpt-6-luna', 'GPT-6 Luna', 'xhigh', 34, 0.04, 23.38),
  entry('codex', 'gpt-6-luna', 'GPT-6 Luna', 'high', 32, 0.03, 12.68),
  entry('codex', 'gpt-6-luna', 'GPT-6 Luna', 'medium', 29, 0.02, 8.78),
  entry('codex', 'gpt-6-luna', 'GPT-6 Luna', 'low', 21, 0.0045, 6.1),
  entry('codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'xhigh', 44, 1.18, 42.8),
  entry('codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'high', 42, 0.81, 25.3),
  entry('codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'medium', 39, 0.5, 13.7),
  entry('codex', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'xhigh', 38, 0.63, 40.5),
  entry('codex', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'high', 34, 0.34, 10.1),
  entry('codex', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'medium', 30, 0.18, 8.5),
  entry('codex', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'high', 32, 0.04, 19),
  entry('agy', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 'high', 41, 1.24, 15.9),
  entry('agy', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 'medium', 40, 0.93, 15.9),
  entry('agy', 'gemini-3.1-pro', 'Gemini 3.1 Pro', 'high', 30, 0.67, 37.3),
]

// size = tamanho relativo da cota (o 5x e o 20x do nome do plano); só pesa enquanto não há leitura de cota, porque o
// percentual lido já é do plano do usuário. models = o que o plano libera (ausente = tudo da empresa). api = paga por uso.
export const PLANS: Record<Family, { label: string; tiers: Tier[] }> = {
  claude: { label: 'Claude', tiers: [
    { id: 'none', label: 'Não tenho', size: 0 },
    { id: 'pro', label: 'Pro', size: 1, models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'] },
    { id: 'max5', label: 'Max 5x', size: 5 },
    { id: 'max20', label: 'Max 20x', size: 20 },
    { id: 'api', label: 'API', size: 20, api: true },
  ] },
  codex: { label: 'ChatGPT', tiers: [
    { id: 'none', label: 'Não tenho', size: 0 },
    { id: 'plus', label: 'Plus', size: 1, models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
    { id: 'pro5', label: 'Pro 5x', size: 5 },
    { id: 'pro20', label: 'Pro 20x', size: 20 },
    { id: 'api', label: 'API', size: 20, api: true },
  ] },
  agy: { label: 'Google', tiers: [
    { id: 'none', label: 'Não tenho', size: 0 },
    { id: 'free', label: 'Gratuito', size: 0.5, models: ['gemini-3.8-flash'] },
    { id: 'ai_pro', label: 'AI Pro', size: 2 },
    { id: 'ultra750', label: 'AI Ultra R$ 750', size: 10 },
    // cota proporcional ao preço até haver número oficial
    { id: 'ultra1000', label: 'AI Ultra R$ 1.000', size: 13 },
  ] },
}

// volume = chamadas por parte (1 = toda rodada): quanto a cota pesa. speed = quanto o tempo pesa (o que mais importa ao
// usuário é o tempo até terminar). minIntelligence = abaixo disso só completa a fila. writer = papel de quem escreve: só nele
// vale a qualidade medida (a aprovação do revisor diz algo de quem escreveu, não de quem revisa ou planeja). ladder = a
// escada de correção. crossFamily = quem revisa nunca é da empresa de quem mais escreve.
export const ROLES: Record<RoleId, Role> = {
  epics: { minIntelligence: 48, speed: 0.1, volume: 0.05, label: 'dividir em épicos' },
  plan: { minIntelligence: 44, speed: 0.2, volume: 0.2, label: 'planejar' },
  plan_edit: { minIntelligence: 30, speed: 0.6, volume: 0.2, label: 'corrigir o plano' },
  test: { minIntelligence: 34, speed: 0.6, volume: 1, writer: true, label: 'escrever a prova' },
  impl_light: { minIntelligence: 30, speed: 0.7, volume: 1, writer: true, label: 'código leve' },
  impl: { minIntelligence: 38, speed: 0.5, volume: 1, writer: true, label: 'código comum' },
  impl_hard: { minIntelligence: 45, speed: 0.2, volume: 0.6, writer: true, label: 'código difícil' },
  fix: { minIntelligence: 38, speed: 0.2, volume: 0.6, writer: true, ladder: true, label: 'correção (escada)' },
  checker: { minIntelligence: 38, speed: 0.5, volume: 1, crossFamily: true, label: 'revisar' },
}

export function tierOf(family: Family, planId: string | undefined): Tier | undefined {
  return PLANS[family].tiers.find((t) => t.id === planId)
}
