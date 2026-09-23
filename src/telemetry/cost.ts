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
  const price = PRICE_PER_MTOK[model]
  const listed = price && input !== null && output !== null && cacheRead !== null && cacheWrite !== null
    ? (input * price.input + output * price.output + cacheRead * price.cache_read + cacheWrite * price.cache_write) / 1_000_000
    : null
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
