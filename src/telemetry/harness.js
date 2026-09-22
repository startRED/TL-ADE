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
