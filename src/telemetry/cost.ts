import type { GitPort } from '../git/gitport.ts'
import { AdeError } from '../journal/errors.ts'
import { isModelCallTelemetry, TelemetryInvalidError } from './telemetry.ts'

type Measure = {
  criteria: number | null
  files: number | null
  rounds: number
  calls: number
  unknown_cost_calls: number
  usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache: number | null
  minutes: number
  // medidas no commit da parte, depois dos rodapés: ausentes antes do commit
  lines_added?: number | null
  lines_removed?: number | null
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** Contador reportado: ausente é desconhecido (null); presente e inválido é recusado. */
function reported(usage: Record<string, unknown>, key: string): number | null {
  const v = usage[key]
  if (v === undefined || v === null) return null
  if (!isCount(v)) throw new TelemetryInvalidError(`${key} reportado deve ser inteiro >= 0`)
  return v
}

// Preço de lista da API em US$ por milhão de tokens: entrada, saída, leitura e escrita (5 min) de cache.
// ponytail: tabela fixa dos modelos em uso; modelo fora dela sem `usd` reportado fica desconhecido.
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  // Codex: tabela da Artificial Analysis colada por Erick em 25/09/2026 (entrada, saída, cache lido e escrito)
  'gpt-6-sol': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'gpt-6-astra': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  // Gemini: preço de lista em 25/09/2026 (3.8 Flash no preço de lançamento até 31/12/2026, depois 1,50/7,50)
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0 },
  'gemini-3.1-pro': { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
}

/** Preço do modelo; o agy manda o esforço no nome (gemini-3.8-flash-medium) e o preço é o mesmo. */
export function priceOf(model: string) {
  return PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[model.replace(/-(low|medium|high|xhigh|max)$/, '')]
}

/**
 * Custo equivalente de API pelos tokens: sem entrada e saída é desconhecido; contador de cache ausente conta zero
 * (o codex não informa cache escrito). Serve às chamadas que não trazem US$ próprio (Codex e Gemini).
 */
export function listPriceUsd(model: string, t: { input: number | null; output: number | null; cache_read?: number | null; cache_write?: number | null }): number | null {
  const price = priceOf(model)
  if (!price || t.input === null || t.output === null) return null
  return (t.input * price.input + t.output * price.output + (t.cache_read ?? 0) * price.cache_read + (t.cache_write ?? 0) * price.cache_write) / 1_000_000
}

/**
 * Custo de uma chamada a partir do uso que o adaptador reportou (`tokens` do recibo).
 * O `usd` reportado vale; sem ele, o preço equivalente sai da tabela do modelo e dos quatro
 * contadores. Sem dado suficiente, preço e tokens ficam null: desconhecido, nunca zero inventado.
 */
export function callCost({ model, usage, durationMs }: { model: string; usage: Record<string, unknown> | undefined; durationMs: number }): {
  usd_equiv: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache: number | null
  minutes: number
} {
  if (typeof model !== 'string' || model === '') throw new TelemetryInvalidError('modelo da chamada ausente')
  if (!isCount(durationMs)) throw new TelemetryInvalidError('durationMs deve ser inteiro >= 0')
  const minutes = durationMs / 60_000
  if (usage?.source !== 'reported') {
    return { usd_equiv: null, tokens_in: null, tokens_out: null, tokens_cache: null, minutes }
  }
  const usd = usage.usd
  if (usd !== undefined && usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) {
    throw new TelemetryInvalidError('usd reportado deve ser número >= 0')
  }
  const cacheRead = reported(usage, 'cache_read')
  const cacheWrite = reported(usage, 'cache_write')
  const input = reported(usage, 'input')
  const output = reported(usage, 'output')
  const listed = listPriceUsd(model, { input, output, cache_read: cacheRead, cache_write: cacheWrite })
  return {
    usd_equiv: typeof usd === 'number' ? usd : listed,
    tokens_in: input,
    tokens_out: output,
    tokens_cache: cacheRead === null || cacheWrite === null ? null : cacheRead + cacheWrite,
    minutes,
  }
}

/**
 * Medida da parte lida do journal: critérios do `story_started`, arquivos do último
 * `contain_result`, rodadas de revisão e a soma exata das chamadas da parte. Tokens e US$
 * desconhecidos ficam fora das somas e contados em `unknown_cost_calls`.
 */
export function storyMeasure(events: Array<Record<string, any>>, storyId: string): Measure {
  // O journal guarda `unit` dentro de `data`; evento montado à mão pode trazê-lo no topo.
  const ofStory = (kind: string) => events.filter((e) => e?.kind === kind && (e.unit ?? e.data?.unit) === storyId)
  const started = ofStory('story_started').at(-1)
  const contained = ofStory('contain_result').at(-1)
  const calls = events.filter((e) => isModelCallTelemetry(e) && e.data.story_id === storyId).map((e) => e.data)
  // Soma só o conhecido; parte cujas chamadas não reportaram nada fica null, não 0.
  const sum = (key: string) => {
    const known = calls.map((c) => c[key]).filter((v): v is number => typeof v === 'number')
    return calls.length > 0 && known.length === 0 ? null : known.reduce((a, v) => a + v, 0)
  }
  const knownCost = calls.filter((c) => typeof c.cost_usd === 'number').length

  return {
    criteria: isCount(started?.data?.criteria) ? started.data.criteria : null,
    files: Array.isArray(contained?.data?.changedPaths) ? contained.data.changedPaths.length : null,
    rounds: ofStory('review_result').length,
    calls: calls.length,
    unknown_cost_calls: calls.length - knownCost,
    usd: sum('cost_usd'),
    tokens_in: sum('tokens_in'),
    tokens_out: sum('tokens_out'),
    tokens_cache: sum('tokens_cache'),
    minutes: sum('minutes') ?? 0,
  }
}

/** Trailers Git da medida da parte, para o fim da mensagem do commit. */
export function formatMeasureTrailers(measure: Measure): string {
  const show = (v: number | null) => (v === null ? 'desconhecido' : String(v))
  const lines = [
    `ADE-Criterios: ${show(measure.criteria)}`,
    `ADE-Arquivos: ${show(measure.files)}`,
    `ADE-Rodadas: ${measure.rounds}`,
    `ADE-USD: ${measure.usd === null ? 'desconhecido' : measure.usd.toFixed(2)}`,
  ]
  if (measure.unknown_cost_calls > 0) lines.push(`ADE-USD-Sem-Custo: ${measure.unknown_cost_calls}`)
  return lines.join('\n')
}

/**
 * Linhas adicionadas e removidas no commit da parte contra o commit-base dela (`git diff --numstat`). Sem base
 * observável ficam null: desconhecido, nunca zero. Arquivo binário não tem linha.
 */
export async function commitLines(git: Pick<GitPort, 'run'>, base: string | null, commit: string | null): Promise<{ lines_added: number | null; lines_removed: number | null }> {
  if (!base || !commit) return { lines_added: null, lines_removed: null }
  const { text } = await git.run(['diff', '--numstat', '--no-renames', base, commit], { maxBuffer: 1 << 26 })
  let added = 0
  let removed = 0
  for (const line of text.split('\n').filter(Boolean)) {
    const [a, r] = line.split('\t')
    if (a !== '-') added += Number(a)
    if (r !== '-') removed += Number(r)
  }
  return { lines_added: added, lines_removed: removed }
}

type Provenance = { mission: string; story: string; round: number; model: string; callSeq: number }

/** Última chamada do maker da parte no journal: o seq do evento de telemetria e o modelo executor. */
export function makerCallOf(events: Array<Record<string, any>>, storyId: string): { callSeq: number; model: string } | null {
  const last = events.filter((e) => isModelCallTelemetry(e) && e.data.story_id === storyId && e.data.role === 'maker').at(-1)
  if (!last || !isCount(last.seq)) return null
  const executor = last.data.models.find((m: { role: string }) => m.role === 'executor') ?? last.data.models[0]
  return { callSeq: last.seq, model: executor.model_id }
}

/** Trailers Git que ligam o commit à conversa que o gerou. */
export function formatProvenanceTrailers({ mission, story, round, model, callSeq }: Provenance): string {
  return [`ADE-Missao: ${mission}`, `ADE-Parte: ${story}`, `ADE-Rodada: ${round}`, `ADE-Modelo: ${model}`, `ADE-Chamada: ${callSeq}`].join('\n')
}

/**
 * Origem lida dos trailers do commit: só o último parágrafo, depois do assunto, e só se todas as
 * linhas dele forem `Chave: valor` (o bloco que o Git reconhece). Sem `ADE-Missao` nesse bloco o
 * commit não é do motor (null), mesmo que o assunto ou o corpo citem o texto; com ele, rodapé
 * incompleto ou fora do formato é recusado, e a missão nunca aponta para fora da pasta.
 */
export function provenanceOfCommit(message: string): Provenance | null {
  const paragraphs = message.trim().split(/\n[ \t]*\n/)
  const block = paragraphs.length > 1 ? (paragraphs.at(-1) as string).split('\n') : []
  if (!block.every((line) => /^[A-Za-z0-9-]+: /.test(line))) return null
  const trailer = (key: string) => block.map((line) => line.match(new RegExp(`^ADE-${key}: *(.+?) *$`))?.[1]).find((v) => v !== undefined)
  const mission = trailer('Missao')
  if (mission === undefined) return null
  const [story, round, model, callSeq] = [trailer('Parte'), trailer('Rodada'), trailer('Modelo'), trailer('Chamada')]
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(mission) || !story || !model || !/^[1-9]\d*$/.test(round ?? '') || !/^\d+$/.test(callSeq ?? '')) {
    throw new AdeError('invalid_provenance', 'rodapé ADE do commit incompleto ou inválido', 2)
  }
  return { mission, story, round: Number(round), model, callSeq: Number(callSeq) }
}
