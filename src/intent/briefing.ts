import { AdeError } from '../journal/errors.ts'
import { roleModelCall } from './plan-critic.ts'

/**
 * Gera o briefing determinístico registrando direção e próxima entrega.
 */
export function generateBriefing({ request = '', discovery = {}, classification = {}, risk = {} }: { request?: string; discovery?: any; classification?: any; risk?: any }): { direction: object; next_delivery: object; classification: object; risk: object } {
  return {
    direction: {
      intent: request,
      vision: `Direção estratégica para: ${request}`,
      target_scope: discovery?.repo?.head ? `head:${discovery.repo.head}` : 'main',
    },
    next_delivery: {
      scope: 'Fatia executável imediata',
      phase: 1,
      deliverable: `Entrega inicial para: ${request.slice(0, 60)}...`,
    },
    classification,
    risk,
  }
}

export type ProductBriefing = {
  title: string
  goal: string
  users?: string
  in_scope: string[]
  out_of_scope: string[]
  done_means: string[]
  constraints: string[]
  versions: Array<{ name: string; goal: string; includes: string[] }>
}

export type Briefer = (input: { request: string; discovery: any; classification: any }) => Promise<unknown>

/** Pedido grande: a mesma régua que já decide pesquisa e time. */
export const LARGE_COMPLEXITIES = new Set(['subsystem', 'project'])

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)
const normalized = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

const BRIEFING_KEYS = ['title', 'goal', 'users', 'in_scope', 'out_of_scope', 'done_means', 'constraints', 'versions']
const VERSION_KEYS = ['name', 'goal', 'includes']
const unknownKey = (o: object, allowed: string[]) => Object.keys(o).find((k) => !allowed.includes(k))

/** Motivo pelo qual o briefing não serve, ou null quando é válido. */
function briefingProblem(b: any): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'briefing ausente'
  const extra = unknownKey(b, BRIEFING_KEYS)
  if (extra) return `campo desconhecido: ${extra}`
  if (!isText(b.title) || !isText(b.goal)) return 'title e goal são obrigatórios'
  if (b.users !== undefined && typeof b.users !== 'string') return 'users deve ser texto'
  for (const key of ['in_scope', 'out_of_scope', 'done_means', 'constraints']) {
    if (!isTextList(b[key])) return `${key} deve ser lista de textos`
  }
  if (b.in_scope.length === 0) return 'in_scope vazio'
  if (!Array.isArray(b.versions) || b.versions.length === 0) return 'briefing sem versões'
  for (const v of b.versions) {
    const extraInVersion = v && typeof v === 'object' ? unknownKey(v, VERSION_KEYS) : undefined
    if (extraInVersion) return `campo desconhecido na versão: ${extraInVersion}`
    if (!isText(v?.name) || !isText(v?.goal) || !isTextList(v?.includes) || v.includes.length === 0) {
      return 'cada versão exige name, goal e includes não vazio'
    }
  }
  return null
}

/** Falha fechado quando o briefing (do briefer ou do disco) não tem a forma exigida. */
export function assertProductBriefing(b: any): asserts b is ProductBriefing {
  const problem = briefingProblem(b)
  if (problem) throw new AdeError('invalid_product_briefing', `briefing de produto inválido: ${problem}`, 2)
}

/**
 * Briefing de produto de pedido grande (lição de proto/server.mjs, makeBrief). Depois do briefer,
 * o motor garante duas regras: o que a descoberta marca como existente sai do escopo, e as
 * regras do repositório entram nas restrições.
 */
export async function generateProductBriefing(
  { request, discovery = {}, classification = {} }: { request: string; discovery?: any; classification?: any },
  briefer: Briefer | undefined,
): Promise<ProductBriefing> {
  if (typeof briefer !== 'function') {
    throw new AdeError('briefer_missing', 'pedido grande exige briefer configurado para gerar o briefing de produto', 2)
  }
  const raw: any = await briefer({ request, discovery, classification })
  assertProductBriefing(raw)

  const existing = new Set((isTextList(discovery.existing_features) ? discovery.existing_features : []).map(normalized))
  const exists = (item: string) => existing.has(normalized(item))
  const rules: string[] = isTextList(discovery.repo_rules) ? discovery.repo_rules : []
  const briefing: ProductBriefing = {
    ...raw,
    in_scope: raw.in_scope.filter((i) => !exists(i)),
    out_of_scope: [...raw.out_of_scope, ...raw.in_scope.filter(exists).map((i) => `${i} (já existe)`)],
    constraints: [...raw.constraints, ...rules.filter((r) => !raw.constraints.includes(r))],
    versions: raw.versions
      .map((v) => ({ name: v.name, goal: v.goal, includes: v.includes.filter((i) => !exists(i)) }))
      .filter((v) => v.includes.length > 0),
  }
  assertProductBriefing(briefing)
  return briefing
}

const textList = { type: 'array', items: { type: 'string' } }
/** Resposta exigida do modelo: a mesma forma que `assertProductBriefing` aceita. */
const PRODUCT_BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: BRIEFING_KEYS,
  properties: {
    title: { type: 'string' },
    goal: { type: 'string' },
    users: { type: 'string' },
    in_scope: textList,
    out_of_scope: textList,
    done_means: textList,
    constraints: textList,
    versions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: VERSION_KEYS,
        properties: { name: { type: 'string' }, goal: { type: 'string' }, includes: textList },
      },
    },
  },
}

function briefingPrompt({ request, discovery, classification }: { request: string; discovery: any; classification: any }): string {
  return [
    'Você vai escrever o BRIEFING DE PRODUTO de um pedido grande, antes de qualquer plano técnico. Não escreva código nem stories.',
    'Preencha: title, goal (uma frase), users, in_scope (o que entra), out_of_scope (o que fica fora), done_means (o que é pronto, verificável), constraints e versions (name, goal, includes; a primeira é a menor entrega útil).',
    'O que já existe no projeto NÃO entra em in_scope. As regras do repositório entram em constraints. Responda em português no JSON exigido.',
    `Pedido do usuário: ${request}`,
    `Classificação: ${classification?.complexity ?? '?'}`,
    `Recursos que já existem: ${JSON.stringify(discovery?.existing_features ?? [])}`,
    `Regras do repositório: ${JSON.stringify(discovery?.repo_rules ?? [])}`,
  ].join('\n')
}

/**
 * Briefer pelas cadeias do papel intent_compiler de .ade/config.json, no mesmo caminho de
 * chamada da crítica do plano; undefined quando o papel não tem cadeia que o motor chame.
 */
export function brieferFromConfig(
  adeConfig: any,
  { missionId, ...runOpts }: { missionId: string } & Parameters<typeof roleModelCall>[2],
): Briefer | undefined {
  const call = roleModelCall(adeConfig, 'intent_compiler', runOpts)
  if (!call) return undefined
  return (input) => call({ missionId, stepId: 'product-briefing', prompt: briefingPrompt(input), schema: PRODUCT_BRIEFING_SCHEMA })
}

/**
 * Pedido, entregas e campos do plano da versão `versionIndex` do briefing aprovado: o briefing
 * vale mais que o pedido original e as versões seguintes ficam fora do escopo do plano.
 */
export function versionPlanOf(product: ProductBriefing, versionIndex: number) {
  const version = product.versions[versionIndex]
  if (!version) {
    throw new AdeError('briefing_version_missing', `briefing "${product.title}" não tem a versão ${versionIndex + 1}: todas foram entregues`, 2, {
      version_index: versionIndex,
    })
  }
  return {
    request: `${product.title} — ${version.name}: ${version.goal}`,
    deliverables: version.includes,
    briefing: {
      product,
      version_index: versionIndex,
      out_of_scope: [...product.out_of_scope, ...product.versions.slice(versionIndex + 1).flatMap((v) => v.includes)],
    },
  }
}
