import { AdeError } from '../journal/errors.ts'
import { callCost } from './cost.ts'

const OUTCOMES = ['ok', 'retry', 'rework', 'park', 'stop']
const MISSION_OUTCOMES = ['completed', 'parked', 'interrupted']
// catalog@<commit> (catálogo antigo), <coleção>@<commit> (fontes do catálogo) ou local
const SKILL_SOURCE = /^([A-Za-z0-9][A-Za-z0-9._-]*@[0-9a-f]{7,40}|local)$/
const SHA256 = /^[0-9a-f]{64}$/

/**
 * Recusa telemetria fora do contrato antes de ela chegar ao journal.
 */
export class TelemetryInvalidError extends AdeError {
  /** @param reason */
  constructor(reason: string) {
    super('telemetry_invalid', `telemetria inválida: ${reason}`, 2, { reason })
  }
}

/** @param v */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * Converte os modelos informados pelo adapter nos papéis da chamada: o modelo pedido é o
 * executor e os demais que a família reportou são advisors.
 *
 */
export function modelsFromUsage(reported: Array<{ model_id: string }>, requested: string|null|undefined): Array<{ role: 'executor'|'advisor'; model_id: string }> {
  const ids = (reported ?? []).map((m) => m.model_id)
  if (ids.length === 0) return [{ role: 'executor', model_id: requested ?? 'unknown' }]
  // ponytail: sem modelo pedido, o primeiro reportado vira executor; o envelope não marca papel.
  const executor = requested && ids.includes(requested) ? requested : (requested ?? ids[0])
  const models = ids.map((id) => ({ role: (id === executor ? 'executor' : 'advisor' as 'executor' | 'advisor'), model_id: id }))
  if (!ids.includes(executor)) models.unshift({ role: 'executor', model_id: executor })
  return models
}

/**
 * Monta e valida o evento de telemetria de uma `model_call` a partir do recibo do adapter
 * e do manifesto do pacote. Custo não observado fica `unknown`, nunca estimado.
 *
 */
export function buildModelTelemetry(input: Record<string,any>): Record<string,any> {
  for (const key of ['mission_id', 'story_id', 'step_id', 'family', 'role', 'effort']) {
    if (typeof input?.[key] !== 'string' || input[key] === '') throw new TelemetryInvalidError(`${key} ausente`)
  }
  const models = input.models
  if (!Array.isArray(models) || models.length === 0 ||
      models.some((m) => (m?.role !== 'executor' && m?.role !== 'advisor') || typeof m.model_id !== 'string' || m.model_id === '')) {
    throw new TelemetryInvalidError('models deve listar executor/advisor com model_id')
  }
  if (!OUTCOMES.includes(input.outcome)) throw new TelemetryInvalidError(`outcome ${input.outcome} fora do contrato`)
  if (input.ttft_ms !== null && !isCount(input.ttft_ms)) throw new TelemetryInvalidError('ttft_ms deve ser inteiro >= 0 ou null')
  for (const key of ['duration_ms', 'approval_decisions', 'network_attempts', 'files_touched', 'tool_output_raw_bytes', 'tool_output_model_bytes']) {
    if (!isCount(input[key])) throw new TelemetryInvalidError(`${key} deve ser inteiro >= 0`)
  }
  if (!Array.isArray(input.sources) || input.sources.some((s) => typeof s !== 'string')) {
    throw new TelemetryInvalidError('sources deve ser lista de digests')
  }
  const cited = new Set(input.sources)

  const pack = input.pack
  if (!pack || !Array.isArray(pack.sections) || !isCount(pack.bytes)) throw new TelemetryInvalidError('pack sem seções ou bytes')
  const packSections = pack.sections.map((s: any) => {
    if (typeof s?.section !== 'string' || !isCount(s.bytes) || typeof s.digest !== 'string') {
      throw new TelemetryInvalidError('seção do pack sem section, bytes ou digest')
    }
    return { section: s.section, bytes: s.bytes, digest: s.digest, cited: cited.has(s.digest) }
  })
  const sum = packSections.reduce((acc: number, s: any) => acc + s.bytes, 0)
  if (sum !== pack.bytes) throw new TelemetryInvalidError(`soma das seções (${sum}) difere de pack_bytes (${pack.bytes})`)

  const skills = (input.skills ?? []).map((s: any) => {
    if (typeof s?.name !== 'string' || !isCount(s.bytes)) throw new TelemetryInvalidError('skill sem nome ou bytes')
    if (!SHA256.test(String(s.sha256))) throw new TelemetryInvalidError(`skill ${s.name} sem sha256 do conteúdo`)
    if (!SKILL_SOURCE.test(String(s.source))) throw new TelemetryInvalidError(`skill ${s.name} com origem ${s.source} (esperado <fonte>@<commit> ou local)`)
    return { name: s.name, bytes: s.bytes, cited: cited.has(s.sha256), sha256: s.sha256, source: s.source }
  })

  const tokens = input.tokens ?? { source: 'unavailable' }
  const reportedTokens = tokens.source === 'reported'
  const usage = input.usage
  const usd = typeof tokens.usd === 'number' && Number.isFinite(tokens.usd)
    ? tokens.usd
    : (usage?.cost_source === 'reported' && typeof usage.cost_usd === 'number' ? usage.cost_usd : null)
  const cost = callCost({
    model: models.find((m) => m.role === 'executor')?.model_id ?? models[0].model_id,
    // Custo reportado sem tokens (agy) conta só o US$; tokens não reportados ficam desconhecidos.
    usage: reportedTokens ? { ...tokens, usd } : { source: usd === null ? 'unavailable' : 'reported', usd },
    durationMs: input.duration_ms,
  })
  const counter = (v: unknown) => (reportedTokens && isCount(v) ? v : null)
  const basis = usd !== null && (usage?.cost_basis === 'list' || usage?.cost_basis === 'invoice') ? usage.cost_basis : null

  return {
    mission_id: input.mission_id,
    story_id: input.story_id,
    step_id: input.step_id,
    family: input.family,
    role: input.role,
    effort: input.effort,
    models: models.map((m) => ({ role: m.role, model_id: m.model_id })),
    duration_ms: input.duration_ms,
    tokens_source: reportedTokens ? 'reported' : 'unknown',
    tokens_in: cost.tokens_in,
    tokens_out: cost.tokens_out,
    cache_read: counter(tokens.cache_read),
    cache_write: counter(tokens.cache_write),
    tokens_cache: cost.tokens_cache,
    minutes: cost.minutes,
    cost_usd: cost.usd_equiv,
    // sem US$ do próprio CLI, o preço de lista pelos tokens vale como estimativa (Codex e Gemini)
    cost_source: usd !== null ? 'reported' : cost.usd_equiv !== null ? 'estimated' : 'unknown',
    cost_basis: basis,
    pack_bytes: pack.bytes,
    pack_sections: packSections,
    skills_injected: skills,
    tool_output_raw_bytes: input.tool_output_raw_bytes,
    tool_output_model_bytes: input.tool_output_model_bytes,
    outcome: input.outcome,
    ttft_ms: input.ttft_ms,
    approval_decisions: input.approval_decisions,
    network_attempts: input.network_attempts,
    files_touched: input.files_touched,
  }
}

/**
 * Evento de telemetria de uma model_call no formato completo (tem `models[]`).
 *
 */
export function isModelCallTelemetry(event: any): boolean {
  return event?.kind === 'telemetry' && Array.isArray(event.data?.models) && event.data?.scope === undefined
}

/**
 * Contadores de tokens no formato dos relatórios, lidos do evento antigo (`tokens`) ou do
 * completo (`tokens_in`...); null quando o evento não é de chamada.
 *
 */
export function telemetryTokens(data: any): Record<string,any>|null {
  if (data?.tokens) return data.tokens
  if (!Array.isArray(data?.models)) return null
  if (data.tokens_source !== 'reported') return { source: 'unavailable' }
  return {
    input: data.tokens_in,
    cache_write: data.cache_write,
    cache_read: data.cache_read,
    output: data.tokens_out,
    usd: data.cost_usd,
    source: 'reported',
  }
}

/**
 * Fecha a missão com um único resumo; devolve null quando o journal já tem um.
 *
 */
export function closeMissionSummary({ mission, events, outcome, capabilitiesDigest }: { mission: { id: string; context?: any }; events: any[]; outcome: string; capabilitiesDigest: string }): { kind: 'telemetry'; data: Record<string,any> }|null {
  if (!MISSION_OUTCOMES.includes(outcome)) throw new TelemetryInvalidError(`outcome ${outcome} de missão fora do contrato`)
  if (typeof mission?.id !== 'string' || typeof capabilitiesDigest !== 'string') {
    throw new TelemetryInvalidError('mission.id e capabilitiesDigest são obrigatórios')
  }
  // um resumo por fechamento: qualquer evento depois do último resumo é a missão reaberta (retomada, nova tentativa) (a parada vira 'parked' e a conclusão, horas depois, 'completed')
  const lastSummary = events.map((e) => e?.kind === 'telemetry' && e.data?.scope === 'mission_summary').lastIndexOf(true)
  if (lastSummary >= 0 && lastSummary === events.length - 1) return null

  const times = events.map((e) => Date.parse(e?.at)).filter(Number.isFinite)
  const duration = times.length > 0 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0
  const calls = events.filter(isModelCallTelemetry)
  const stampCaps = events.map((e) => String(e?.runtime_stamp ?? '').split(':')[2]).filter(Boolean)

  const commands = new Set(['run'])
  if (mission.context) commands.add('plan')
  for (const e of events) {
    if (e?.kind === 'decision' && e.data?.decision === 'plan_approved') commands.add('approve')
    if (e?.kind === 'run_resumed' || e?.kind === 'story_resumed') commands.add('resume')
  }

  let cost = 0
  for (const c of calls) if (typeof c.data.cost_usd === 'number') cost += c.data.cost_usd

  return {
    kind: 'telemetry',
    data: {
      scope: 'mission_summary',
      mission_id: mission.id,
      outcome,
      interventions: events.filter((e) =>
        (e?.kind === 'decision' && e.source === 'operator') || e?.kind === 'human_takeover').length,
      questions: Array.isArray(mission.context?.questions) ? mission.context.questions.length : 0,
      duration_ms: duration,
      commands: [...commands].sort(),
      capabilities_digest: capabilitiesDigest,
      capabilities_divergent: stampCaps.some((d) => d !== capabilitiesDigest),
      model_calls: calls.length,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      cost_unknown_calls: calls.filter((c) => c.data.cost_source === 'unknown').length,
    },
  }
}
