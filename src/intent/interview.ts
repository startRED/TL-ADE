const STOPWORDS = new Set([
  'qual',
  'quais',
  'quanto',
  'quantos',
  'como',
  'onde',
  'o',
  'a',
  'os',
  'as',
  'um',
  'uma',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'no',
  'na',
  'nos',
  'nas',
  'em',
  'para',
  'por',
  'com',
  'que',
  'e',
  'ou',
  'ser',
  'deve',
  'devemos',
  'usar',
  'utilizado',
  'utilizada',
  'projeto',
])

/** Sinônimos em português dos fatos descobríveis expostos por discovery/IR. */

const FACT_ALIASES: Record<string, string[]> = {
  database: ['banco', 'bd', 'database', 'dados'],
  test_runner: ['runner', 'teste', 'testes'],
  test: ['runner', 'teste', 'testes'],
  language: ['linguagem', 'language'],
  framework: ['framework'],
  package_manager: ['gerenciador', 'pacotes'],
}

function normalizeText(text: unknown) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentTokens(text: unknown) {
  return new Set(normalizeText(text).split(' ').filter((t) => t.length > 2 && !STOPWORDS.has(t)))
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) {
    if (b.has(t)) inter++
  }
  return inter / (a.size + b.size - inter)
}

/**
 * Um alias casa com a pergunta quando aparece como frase inteira no texto normalizado
 * (cobre chaves de várias palavras, como "deployment target") ou quando todos os seus
 * termos estão entre os tokens de conteúdo da pergunta (cobre ordem invertida).
 */
function matchesAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizeText(alias)
  if (!normalizedAlias) return false

  const normalizedText = normalizeText(text)
  if (new RegExp(`(^| )${normalizedAlias}( |$)`).test(normalizedText)) return true

  const aliasTokens = normalizedAlias.split(' ').filter((t) => t.length > 2)
  if (aliasTokens.length === 0) return false

  const tokens = contentTokens(text)
  return aliasTokens.every((t) => tokens.has(t))
}

/**
 * Indexa os fatos já descobertos (discovery e IR) para recusar perguntas respondíveis.
 */
function buildFactIndex(discovery: any, repoIr: any): Array<{ key: string; value: string; ref: string; aliases: string[] }> {
  const index = []
  const sources = [
    ['discovery.facts', discovery.facts],
    ['repoIr.facts', repoIr.facts],
    ['discovery.scripts', discovery.scripts],
    ['discovery.tests', discovery.tests],
    ['repoIr.scripts', repoIr.scripts],
  ]

  for (const [prefix, bag] of sources) {
    if (!bag || typeof bag !== 'object') continue
    for (const [key, value] of Object.entries(bag)) {
      if (value === null || value === undefined || typeof value === 'object') continue
      index.push({
        key,
        value: String(value),
        ref: `${prefix}.${key}:${value}`,
        // Chave genérica (deployment_target) vira frase normalizada: "deployment target".
        aliases: FACT_ALIASES[key] || [normalizeText(key.replace(/[_-]+/g, ' '))],
      })
    }
  }

  return index
}

/**
 * Resolve fatos conhecidos e identifica perguntas que devem ser recusadas.
 */
export function getRefusedQuestions({ unknowns = [], discovery = {}, repoIr = {} }: { unknowns?: any[]; discovery?: any; repoIr?: any }): Array<{ question: string; kind?: string; evidence: string }> {
  const refused = []
  const answerable = discovery.answerable || []
  const facts = buildFactIndex(discovery, repoIr)

  const findFact = (text: string) => facts.find((f) => f.aliases.some((alias) => matchesAlias(text, alias)))

  // Itens declarados explicitamente em discovery.answerable
  for (const item of answerable) {
    const fact = findFact(item)
    refused.push({
      question: item,
      evidence: fact ? fact.ref : `discovery.answerable:${item}`,
    })
  }

  // Perguntas cujo fato já está disponível em discovery/IR
  for (const u of unknowns) {
    const text = u.question || u.text || ''
    const normalized = normalizeText(text)
    if (refused.some((r) => normalizeText(r.question) === normalized)) continue

    const inAnswerable = answerable.some((a: any) => {
      const na = normalizeText(a)
      return na.includes(normalized) || normalized.includes(na)
    })

    const fact = u.kind === 'repo_fact' || inAnswerable ? findFact(text) : undefined

    if (inAnswerable || fact) {
      refused.push({
        question: text,
        kind: u.kind,
        evidence: fact ? fact.ref : `discovery.answerable:${text}`,
      })
    }
  }

  return refused
}

/**
 * Constrói a lista de perguntas indispensáveis para a entrevista (máximo 5),
 * recusando fatos já conhecidos e fundindo perguntas duplicadas.
 */
export function buildInterview({ unknowns = [], discovery = {}, repoIr = {}, maxQuestions = 5 }: { unknowns?: any[]; discovery?: any; repoIr?: any; maxQuestions?: number }): Array<{ id: string; unknown_ref: string; kind: string; text: string; options: any[]; default_if_unknown?: string }> {
  if (!Array.isArray(unknowns)) {
    throw new TypeError('buildInterview: unknowns deve ser uma lista')
  }

  const refused = getRefusedQuestions({ unknowns, discovery, repoIr })
  const refusedNormalized = refused.map((r) => normalizeText(r.question))

  
  const candidates: any[] = []
  const seenRefs = new Set()

  for (let i = 0; i < unknowns.length; i++) {
    const u = unknowns[i]
    const text = (u.question || u.text || '').trim()
    const normalized = normalizeText(text)
    if (!normalized) continue

    // Fato já respondível pelo projeto: recusado, nunca perguntado
    if (refusedNormalized.some((r) => r === normalized || normalized.includes(r) || r.includes(normalized))) {
      continue
    }

    if (u.unknown_ref && seenRefs.has(u.unknown_ref)) continue

    // ponytail: comparação O(n²) por similaridade de tokens; basta para <= dezenas de dúvidas
    const tokens = contentTokens(text)
    if (candidates.some((c) => jaccard(c.tokens, tokens) >= 0.5)) continue

    if (u.unknown_ref) seenRefs.add(u.unknown_ref)

    // Montar opções garantindo recomendação primeiro e opção não sei
    let options = Array.isArray(u.options) ? [...u.options] : []
    if (options.length === 0) {
      options = [
        {
          id: `opt-${i}-recommended`,
          label: 'Padrão recomendado pelo projeto',
          recommended: true,
          why: 'Configuração padrão de v0.3',
        },
        {
          id: `opt-${i}-alt`,
          label: 'Opção alternativa configurável',
        },
        {
          id: 'dont_know',
          label: 'Não sei (adotar recomendação)',
        },
      ]
    } else {
      if (!options.some((o) => o.recommended)) {
        options[0] = { ...options[0], recommended: true }
      }
      if (!options.some((o) => normalizeText(o.label).includes('nao sei'))) {
        options.push({ id: 'dont_know', label: 'Não sei' })
      }
    }

    candidates.push({
      id: u.id || `Q${candidates.length + 1}`,
      unknown_ref: u.unknown_ref || u.id || `U${candidates.length + 1}`,
      kind: u.kind || 'product_choice',
      text,
      options,
      default_if_unknown: u.default_if_unknown || options.find((o: any) => o.recommended)?.id || options[0]?.id,
      tokens,
    })
  }

  return candidates.slice(0, maxQuestions).map(({ tokens: _tokens, ...q }) => q)
}

/**
 * Aplica a resposta do operador a um contrato, registrando defaults adotados e justificativas.
 * O contrato mantém apenas os campos admitidos pelo schema; valor padrão e justificativa
 * ficam na decisão retornada.
 */
export function applyInterviewAnswer(contract: any, question: any, answer: any): { contract: any; decision: any } {
  if (!contract || typeof contract !== 'object') {
    throw new TypeError('applyInterviewAnswer: contrato inválido')
  }
  if (!question || typeof question !== 'object') {
    throw new TypeError('applyInterviewAnswer: pergunta inválida')
  }

  const normalizedAnswer = normalizeText(answer)
  const isDontKnow = !answer || normalizedAnswer === 'nao sei' || normalizedAnswer === 'dont know' || answer === 'dont_know'

  const unknownId = question.unknown_ref || question.id
  
  const unknownEntry: { id: any; question: any; kind: any; resolved_by?: string } = {
    id: unknownId,
    question: question.text || question.question,
    kind: question.kind || 'product_choice',
  }

  let decision

  if (isDontKnow) {
    const recommendedOpt =
      (question.options || []).find((o: any) => o.recommended) ||
      (question.options || []).find((o: any) => o.id === question.default_if_unknown) ||
      (question.options || [])[0]

    const defaultValue = question.default_if_unknown || recommendedOpt?.id || 'default'
    const rationale = recommendedOpt?.why || 'Padrão de telemetria v0.3'

    decision = {
      kind: 'default_assumed',
      unknown_id: unknownId,
      default_value: defaultValue,
      rationale,
    }
    unknownEntry.resolved_by = 'default_assumed'
  } else {
    decision = {
      kind: 'operator_choice',
      unknown_id: unknownId,
      value: answer,
    }
    unknownEntry.resolved_by = 'operator_choice'
  }

  return {
    contract: {
      ...contract,
      unknowns: [...(contract.unknowns || []), unknownEntry],
    },
    decision,
  }
}
