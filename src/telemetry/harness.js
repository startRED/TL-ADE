// @ts-check
import { isModelCallTelemetry } from './telemetry.js'

const PRUNE_WINDOW = 20
const PRUNE_MIN_RATE = 0.2
const PAIRS_REQUIRED = 5

/** @param {any} config @returns {string[]} */
function optIn(config) {
  return Array.isArray(config?.harness?.opt_in) ? config.harness.opt_in : []
}

/**
 * Cache por papel: cache_read / (tokens_in + cache_read), null com denominador zero.
 *
 * @param {any[]} calls
 */
function cacheByRole(calls) {
  /** @type {Map<string, { role: string, tokens_in: number, cache_read: number, ratio: number | null }>} */
  const byRole = new Map()
  for (const c of calls) {
    const role = String(c.data.role)
    const entry = byRole.get(role) ?? { role, tokens_in: 0, cache_read: 0, ratio: null }
    entry.tokens_in += c.data.tokens_in
    entry.cache_read += c.data.cache_read
    byRole.set(role, entry)
  }
  return [...byRole.values()]
    .map((e) => ({ ...e, ratio: e.tokens_in + e.cache_read === 0 ? null : e.cache_read / (e.tokens_in + e.cache_read) }))
    .sort((a, b) => a.role.localeCompare(b.role))
}

/**
 * Diagnóstico do harness nas sete categorias aprovadas, calculado só pelos eventos do journal.
 * Cada verificação traz como evidência os `seq` que a sustentam (ou que a derrubam).
 *
 * @param {any[]} events
 * @param {any} _config
 */
export function auditHarness(events, _config) {
  const calls = events.filter(isModelCallTelemetry)
  const seqs = (/** @type {(e: any) => boolean} */ pred) => events.filter(pred).map((e) => e.seq)
  /** @type {Array<{ id: string, category: string, action: string, bad?: (e: any) => boolean, good?: (e: any) => boolean }>} */
  const specs = [
    { id: 'models_identified', category: 'tool_coverage', action: 'registrar o model_id reportado por toda família',
      bad: (e) => isModelCallTelemetry(e) && e.data.models.some((/** @type {any} */ m) => m.model_id === 'unknown') },
    { id: 'tokens_reported', category: 'tool_coverage', action: 'ler os tokens do envelope de toda família',
      bad: (e) => isModelCallTelemetry(e) && e.data.tokens_source !== 'reported' },
    { id: 'pack_sources_cited', category: 'context_efficiency', action: 'exigir fontes citadas no resultado da unidade',
      bad: (e) => isModelCallTelemetry(e) && !e.data.pack_sections.some((/** @type {any} */ s) => s.cited) &&
        !e.data.skills_injected.some((/** @type {any} */ s) => s.cited) },
    { id: 'gates_passed', category: 'quality_gates', action: 'rodar os portões determinísticos antes do commit',
      good: (e) => e?.kind === 'gates_done' && e.data?.ok === true },
    { id: 'review_recorded', category: 'quality_gates', action: 'registrar a revisão de outra família',
      good: (e) => e?.kind === 'review_result' },
    { id: 'mission_summary_recorded', category: 'memory_persistence', action: 'fechar a missão com mission_summary',
      good: (e) => e?.kind === 'telemetry' && e.data?.scope === 'mission_summary' },
    { id: 'eval_red_first', category: 'eval_coverage', action: 'executar a prova vermelha antes da implementação',
      good: (e) => e?.kind === 'step_result' && String(e.step_id ?? '').includes(':eval:red:') },
    { id: 'no_canary_escape', category: 'security_guardrails', action: 'investigar a fuga do canário e manter a família desabilitada',
      bad: (e) => e?.data?.reason === 'canary_escaped' || e?.data?.code === 'canary_escaped' },
    { id: 'containment_checked', category: 'security_guardrails', action: 'verificar a contenção de cada unidade',
      good: (e) => e?.kind === 'contain_result' },
    { id: 'cost_observed', category: 'cost_efficiency', action: 'usar família que reporte custo ou aceitar custo unknown explicitamente',
      bad: (e) => isModelCallTelemetry(e) && e.data.cost_source !== 'reported' },
    { id: 'cache_used', category: 'cost_efficiency', action: 'estabilizar o prefixo do pacote para aproveitar cache',
      good: (e) => isModelCallTelemetry(e) && e.data.cache_read > 0 },
  ]

  const checks = specs.map((s) => {
    if (s.bad) {
      const evidence = seqs(s.bad)
      return { id: s.id, category: s.category, pass: evidence.length === 0, evidence, action: s.action }
    }
    const evidence = seqs(/** @type {(e: any) => boolean} */ (s.good))
    return { id: s.id, category: s.category, pass: evidence.length > 0, evidence, action: s.action }
  })

  const empty = events.length === 0
  /** @type {Record<string, { score: number | null, passed: number, total: number }>} */
  const categories = {}
  for (const c of checks) {
    const cat = categories[c.category] ?? { score: null, passed: 0, total: 0 }
    cat.total++
    if (c.pass) cat.passed++
    categories[c.category] = cat
  }
  for (const cat of Object.values(categories)) cat.score = empty ? null : Math.round((cat.passed / cat.total) * 100)
  const passed = checks.filter((c) => c.pass).length

  return {
    score: empty ? null : Math.round((passed / checks.length) * 100),
    categories,
    checks,
    top_actions: empty ? [] : checks.filter((c) => !c.pass).slice(0, 3).map((c) => ({ check: c.id, action: c.action })),
    cache_by_role: cacheByRole(calls),
  }
}

/**
 * Poda reversível do padrão: componente (skill ou seção) citado em menos de 20% das últimas 20
 * stories em que foi injetado sai do padrão. Não apaga nada; `harness.opt_in` o reativa.
 *
 * @param {{ events: any[], config: any }} input
 */
export function evaluateDefaultPruning({ events, config }) {
  /** @type {Map<string, Map<string, boolean>>} componente → story → citada */
  const usage = new Map()
  const mark = (/** @type {string} */ component, /** @type {string} */ story, /** @type {boolean} */ cited) => {
    const stories = usage.get(component) ?? new Map()
    stories.set(story, (stories.get(story) ?? false) || cited)
    usage.set(component, stories)
  }
  for (const e of events.filter(isModelCallTelemetry)) {
    for (const s of e.data.skills_injected) mark(`skill:${s.name}`, e.data.story_id, s.cited)
    for (const s of e.data.pack_sections) mark(`section:${s.section}`, e.data.story_id, s.cited)
  }
  const done = new Set(events
    .filter((e) => e?.kind === 'decision' && e.data?.decision === 'harness_default_pruned')
    .map((e) => e.data.component))
  const kept = new Set(optIn(config))

  const decisions = []
  for (const [component, stories] of usage) {
    if (done.has(component) || kept.has(component) || stories.size < PRUNE_WINDOW) continue
    const window = [...stories.values()].slice(-PRUNE_WINDOW)
    const cited = window.filter(Boolean).length
    const rate = cited / PRUNE_WINDOW
    if (rate >= PRUNE_MIN_RATE) continue
    decisions.push({
      decision: 'harness_default_pruned',
      component,
      stories: PRUNE_WINDOW,
      cited_stories: cited,
      citation_rate: rate,
      reactivate_with: 'harness.opt_in',
    })
  }
  return decisions
}

/**
 * Promoção de modelo a padrão: exige cinco pares válidos (com e sem) por componente afetado e,
 * mesmo assim, aprovação em `harness.approved_models`.
 *
 * @param {{ events: any[], candidate: string, components: string[], config: any }} input
 */
export function evaluateModelPromotion({ events, candidate, components, config }) {
  const missing = []
  for (const component of components) {
    const runs = events.filter((e) => e?.kind === 'ablation_run' && e.data?.model_id === candidate &&
      e.data.component === component && e.data.valid === true)
    const pairs = Math.min(
      runs.filter((e) => e.data.variant === 'with').length,
      runs.filter((e) => e.data.variant === 'without').length,
    )
    if (pairs < PAIRS_REQUIRED) missing.push({ component, pairs, required: PAIRS_REQUIRED })
  }
  if (missing.length > 0) return { allowed: false, missing, reason: 'missing_paired_evidence' }
  const approved = Array.isArray(config?.harness?.approved_models) && config.harness.approved_models.includes(candidate)
  return approved ? { allowed: true, missing: [], reason: null } : { allowed: false, missing: [], reason: 'not_approved_in_config' }
}

const CALIBRATION_WINDOW = 20
const ESCAPED_MAX_RATE = 0.1
/** Limites de fábrica quando `.ade/config.json` não os fixa (ADR 0010, ADR 0011, master-spec §limits). */
export const CALIBRATION_DEFAULTS = Object.freeze({ max_pack_bytes: 120000, review_max_diff_bytes: 60000, visual_cut: 7.5 })

/** @param {any} e */
const unitOf = (e) => e?.unit ?? e?.data?.unit

/** p90 por posição mais próxima: o menor valor que cobre 90% das observações. @param {number[]} values */
function p90(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.9 * sorted.length) - 1]
}

/**
 * Limites em vigor lidos da configuração aprovada; campo ausente vale o de fábrica.
 *
 * @param {any} config
 * @returns {{ max_pack_bytes: number, review_max_diff_bytes: number, visual_cut: number }}
 */
export function limitsInForce(config) {
  return {
    max_pack_bytes: config?.limits?.max_pack_bytes ?? CALIBRATION_DEFAULTS.max_pack_bytes,
    review_max_diff_bytes: config?.limits?.review?.max_diff_bytes ?? CALIBRATION_DEFAULTS.review_max_diff_bytes,
    visual_cut: config?.visual?.cut ?? CALIBRATION_DEFAULTS.visual_cut,
  }
}

/**
 * Proposta de calibração derivada só da telemetria já gravada: teto do pack e corte do diff de
 * revisão pelo p90 observado, corte visual pelo critério publicado (E39). Nunca aplica nada; sem
 * amostra suficiente devolve `proposta: null` com o motivo em vez de inventar número.
 *
 * @param {any[]} events
 * @returns {{ max_pack_bytes?: number, review_max_diff_bytes?: number, visual_cut?: number, motivo: string, amostra: number } | { proposta: null, motivo: string }}
 */
export function calibrate(events) {
  const calls = events.filter(isModelCallTelemetry)
  /** @type {{ max_pack_bytes?: number, review_max_diff_bytes?: number, visual_cut?: number }} */
  const proposal = {}
  const reasons = []
  const stories = new Set()

  /** @type {Array<[ 'max_pack_bytes' | 'review_max_diff_bytes', string, any[], number[]]>} */
  const ceilings = [
    ['max_pack_bytes', 'pack_bytes', calls, calls.map((c) => c.data.pack_bytes)],
  ]
  const diffCalls = calls.filter((c) => c.data.pack_sections.some((/** @type {any} */ s) => s.section === 'diff'))
  ceilings.push(['review_max_diff_bytes', 'bytes da seção diff', diffCalls,
    diffCalls.map((c) => c.data.pack_sections.filter((/** @type {any} */ s) => s.section === 'diff')
      .reduce((/** @type {number} */ acc, /** @type {any} */ s) => acc + s.bytes, 0))])
  for (const [key, label, source, values] of ceilings) {
    if (values.length < CALIBRATION_WINDOW) {
      reasons.push(`${key}: ${values.length} observações de ${label}, mínimo ${CALIBRATION_WINDOW}`)
      continue
    }
    proposal[key] = p90(values)
    for (const c of source) stories.add(c.data.story_id)
    reasons.push(`${key}: p90 de ${label} em ${values.length} chamadas = ${proposal[key]}`)
  }

  const uiStories = [...new Set(events.filter((e) => e?.kind === 'visual_eval_done').map(unitOf))]
  if (uiStories.length < CALIBRATION_WINDOW) {
    reasons.push(`visual_cut: ${uiStories.length} stories com UI, critério publicado exige ${CALIBRATION_WINDOW}`)
  } else {
    const window = new Set(uiStories.slice(-CALIBRATION_WINDOW))
    const escaped = events.filter((e) => e?.kind === 'visual_defect_escaped' && window.has(unitOf(e))).length
    const parkedVisual = new Set(events.filter((e) => e?.kind === 'story_done' && window.has(unitOf(e)) &&
      e.data?.status === 'awaiting_operator' && e.data?.reason === 'visual_cut_not_met').map(unitOf))
    const firstSight = new Set(events.filter((e) => e?.kind === 'decision' && e.source === 'operator' &&
      e.data?.decision === 'visual_accepted_as_is' && parkedVisual.has(unitOf(e))).map(unitOf)).size
    const raise = escaped / CALIBRATION_WINDOW > ESCAPED_MAX_RATE
    const escapedText = `escaped_visual_defects ${escaped}/${CALIBRATION_WINDOW} = ${Math.round((escaped / CALIBRATION_WINDOW) * 100)}%`
    const firstSightText = `${firstSight} de ${CALIBRATION_WINDOW} stories aguardaram operador por visual_cut_not_met e foram aprovadas à primeira vista`
    if (raise && firstSight > 0) {
      reasons.push(`visual_cut: gatilhos opostos (${escapedText}; ${firstSightText}); corte mantido até o operador decidir`)
    } else if (raise) {
      proposal.visual_cut = 8
      reasons.push(`visual_cut: ${escapedText} > 10% em ${CALIBRATION_WINDOW} stories com UI → corte 8,0`)
    } else if (firstSight > 0) {
      proposal.visual_cut = 7
      reasons.push(`visual_cut: ${firstSightText} → corte 7,0`)
    } else {
      reasons.push(`visual_cut: nenhum gatilho publicado (${escapedText}; ${firstSightText})`)
    }
    if (proposal.visual_cut !== undefined) for (const s of window) stories.add(s)
  }

  const motivo = reasons.join('; ')
  if (Object.keys(proposal).length === 0) return { proposta: null, motivo }
  return { ...proposal, motivo, amostra: stories.size }
}

/**
 * Diferenças entre a última proposta registrada e os limites em vigor; vazio quando a
 * configuração aprovada já a absorveu ou não há proposta.
 *
 * @param {any[]} events
 * @param {ReturnType<typeof limitsInForce>} inForce
 * @returns {string[]}
 */
export function pendingCalibration(events, inForce) {
  const last = [...events].reverse().find((e) => e?.kind === 'calibration_proposed')
  if (!last) return []
  return /** @type {const} */ (['max_pack_bytes', 'review_max_diff_bytes', 'visual_cut'])
    .filter((k) => last.data.proposta[k] !== undefined && last.data.proposta[k] !== inForce[k])
    .map((k) => `${k}: ${inForce[k]} em vigor, proposto ${last.data.proposta[k]}`)
}
