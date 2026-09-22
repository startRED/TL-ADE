// Filas de modelo montadas a partir dos planos do usuário. Dois retornos separados:
//  - CAPACIDADE (cota e custo): quanto cada empresa ainda aguenta na semana, projetado pelo ritmo de gasto. Pesa nos papéis de
//    muito volume (escrever, provar, revisar) e decide a ordem entre modelos de qualidade parecida.
//  - QUALIDADE (rodadas): inteligência medida pela Artificial Analysis, corrigida pelo que cada modelo entregou aqui (revisor
//    aprovou depois da chamada dele, chamada que não mudou arquivo nenhum). A escada de correção sobe nessa ordem: rodada que
//    falha vai para um modelo mais inteligente, não para um mais barato.

// Artificial Analysis (artificialanalysis.ai, tabela principal lida em 22/09/2026): ai = Intelligence Index v4.3, cpt = custo em
// US$ para rodar o índice (proxy de quanto a chamada pesa na cota), tps = tokens de saída por segundo. tb = Terminal-Bench 4.0
// publicado pela Anthropic no lançamento do Opus 5.5 (só onde há número). Esforço sem linha no site fica fora.
export const CATALOG = [
  { family: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'max', ai: 58, cpt: 5.98, tps: 70 },
  { family: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'xhigh', ai: 56, cpt: 3.46, tps: 74 },
  { family: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'high', ai: 54, cpt: 1.82, tps: 85, tb: 66.4 },
  { family: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'medium', ai: 51, cpt: 1.34, tps: 76 },
  { family: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'low', ai: 42, cpt: 0.55, tps: 86 },
  { family: 'claude', model: 'fable', label: 'Fable 5.1', effort: 'xhigh', ai: 53, cpt: 5.98, tps: 59 },
  { family: 'claude', model: 'fable', label: 'Fable 5.1', effort: 'high', ai: 51, cpt: 3.91, tps: 56, tb: 55.8 },
  { family: 'claude', model: 'fable', label: 'Fable 5.1', effort: 'medium', ai: 49, cpt: 2.98, tps: 55 },
  { family: 'claude', model: 'opus', label: 'Opus 5', effort: 'high', ai: 48, cpt: 3.61, tps: 56, tb: 52.3 },
  { family: 'claude', model: 'opus', label: 'Opus 5', effort: 'medium', ai: 45, cpt: 2.19, tps: 57 },
  { family: 'claude', model: 'sonnet', label: 'Sonnet 5', effort: 'high', ai: 32, cpt: 1.79, tps: 68 },
  { family: 'claude', model: 'haiku', label: 'Haiku 4.5', effort: 'high', ai: 17, cpt: 0.21, tps: 104 },
  { family: 'codex', model: 'gpt-6-astra', label: 'GPT-6 Astra', effort: 'high', ai: 51, cpt: 1.73, tps: 49, tb: 57.9 },
  { family: 'codex', model: 'gpt-6-astra', label: 'GPT-6 Astra', effort: 'medium', ai: 50, cpt: 1.54, tps: 47 },
  { family: 'codex', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effort: 'xhigh', ai: 44, cpt: 1.18, tps: 69 },
  { family: 'codex', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effort: 'high', ai: 42, cpt: 0.81, tps: 64, tb: 37.3 },
  { family: 'codex', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effort: 'medium', ai: 39, cpt: 0.5, tps: 58 },
  { family: 'codex', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effort: 'xhigh', ai: 38, cpt: 0.63, tps: 84 },
  { family: 'codex', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effort: 'high', ai: 34, cpt: 0.34, tps: 77 },
  { family: 'codex', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effort: 'medium', ai: 30, cpt: 0.18, tps: 77 },
  { family: 'codex', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', effort: 'high', ai: 32, cpt: 0.04, tps: 130 },
  { family: 'agy', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', effort: 'high', ai: 41, cpt: 1.24, tps: 297 },
  { family: 'agy', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', effort: 'medium', ai: 40, cpt: 0.93, tps: 297 },
  { family: 'agy', model: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', effort: 'high', ai: 30, cpt: 0.67, tps: 115 },
]

// Planos por empresa. cap = tamanho relativo da cota (o nome do plano: 5x, 20x); só vale enquanto não há leitura de cota, porque
// o % lido já é do plano do usuário. models = o que o plano libera (ausente = tudo da família). api = paga por chamada.
export const PLANS = {
  claude: { label: 'Claude', tiers: [
    { id: 'none', label: 'Não tenho', cap: 0 },
    { id: 'pro', label: 'Pro (US$ 20)', cap: 1, models: ['claude-opus-5-5', 'sonnet', 'haiku'] },
    { id: 'max5', label: 'Max 5x (US$ 100)', cap: 5 },
    { id: 'max20', label: 'Max 20x (US$ 200)', cap: 20 },
    { id: 'api', label: 'API (paga por uso)', cap: 20, api: true },
  ] },
  codex: { label: 'ChatGPT / Codex', tiers: [
    { id: 'none', label: 'Não tenho', cap: 0 },
    { id: 'plus', label: 'Plus (US$ 20)', cap: 1, models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
    { id: 'pro_lite', label: 'Pro 5x (US$ 100)', cap: 5 },
    { id: 'pro', label: 'Pro 20x (US$ 200)', cap: 20 },
    { id: 'api', label: 'API (paga por uso)', cap: 20, api: true },
  ] },
  agy: { label: 'Google (Antigravity)', tiers: [
    { id: 'none', label: 'Não tenho', cap: 0 },
    { id: 'free', label: 'Gratuito', cap: 0.5, models: ['gemini-3.8-flash'] },
    { id: 'ai_pro', label: 'AI Pro (US$ 20)', cap: 2 },
    { id: 'ultra', label: 'AI Ultra (US$ 250)', cap: 10 },
  ] },
}

// O que cada papel precisa. volume = chamadas por parte (1 = a cada rodada): quanto a cota pesa. speed = quanto o tempo pesa
// (Erick, 22/09: o que mais importa é o tempo até terminar). minAi = abaixo disso não entra. ladder = fila em ordem crescente de
// qualidade (a escada sobe a cada duas rodadas que falham). cross = precisa de 2 empresas (quem escreve nunca revisa).
export const ROLES = {
  epics: { minAi: 48, speed: 0.1, volume: 0.05, label: 'dividir em épicos' },
  plan: { minAi: 44, speed: 0.2, volume: 0.2, label: 'planejar' },
  plan_edit: { minAi: 30, speed: 0.6, volume: 0.2, label: 'corrigir o plano' },
  prova: { minAi: 34, speed: 0.6, volume: 1, label: 'escrever a prova' },
  impl_light: { minAi: 30, speed: 0.7, volume: 1, label: 'código leve' },
  impl: { minAi: 38, speed: 0.5, volume: 1, label: 'código comum' },
  impl_hard: { minAi: 45, speed: 0.2, volume: 0.6, label: 'código difícil' },
  fix: { minAi: 38, speed: 0.2, volume: 0.6, ladder: true, label: 'correção (escada)' },
  checker: { minAi: 38, speed: 0.5, volume: 1, cross: true, label: 'revisar' },
}

const WEEK = 7 * 24 * 3600 * 1000
// CAPACIDADE: fração da cota semanal que a família terá gasto na renovação se o ritmo seguir (1 = acaba junto com a semana).
// Sem leitura (o Gemini não expõe cota), estima pelo tamanho do plano.
export function pressure(tier, quota, now = Date.now()) {
  if (!tier || !tier.cap) return Infinity
  if (tier.api) return 0
  const w = quota?.seven_day
  if (w && Number.isFinite(w.used) && w.resets_at) {
    const left = Math.min(1, Math.max(0, (new Date(w.resets_at) - now) / WEEK)), elapsed = 1 - left
    return Math.max(0, (elapsed > 0.1 ? w.used / elapsed : w.used) / 100)
  }
  return tier.cap >= 10 ? 0.3 : tier.cap >= 5 ? 0.5 : 0.8
}

// QUALIDADE medida aqui, do journal do motor: depois de cada chamada de quem escreve, o próximo parecer do revisor, e se a
// chamada mudou algum arquivo. Por modelo (todas as funções de escrever juntas; separar por papel deixaria amostras pequenas).
export function measure(events) {
  const out = {}
  let last = null
  for (const e of events) {
    const t = String(e.text || '')
    if (e.type === 'model_call' && /implementação|prova e código/.test(e.role || '')) {
      const g = out[e.model] || (out[e.model] = { calls: 0, approved: 0, reviewed: 0, zero: 0, timed: 0, min: 0 })
      g.calls++
      const f = e.files ?? e.touched; if (f === 0) g.zero++
      const ms = e.wall_ms ?? e.duration_ms; if (ms) { g.timed++; g.min += ms / 60000 }
      last = { model: e.model, reviewed: false }
    }
    const v = /^(aprovou|pediu mudanças):/.exec(t)
    if (v && last && !last.reviewed) { last.reviewed = true; const g = out[last.model]; g.reviewed++; if (v[1] === 'aprovou') g.approved++ }
  }
  return out
}
// o journal grava o Gemini com o esforço no nome (gemini-3.8-flash-high); os outros, só o modelo
const measuredOf = (measured, e) => measured?.[`${e.model}-${e.effort}`] || measured?.[e.model] || null

// Nota de um modelo num papel, com o porquê de cada parcela.
export function scoreFor(entry, role, { tier, quota, measured, now } = {}) {
  const r = ROLES[role], parts = []
  let q = entry.ai; parts.push(`inteligência ${entry.ai}`)
  const g = measuredOf(measured, entry)
  if (g?.reviewed >= 5) { // retorno de QUALIDADE: aprovação do revisor contra a média, com peso pela amostra
    const w = g.reviewed / (g.reviewed + 10), adj = (g.approved / g.reviewed - 0.4) * 30 * w - (g.zero / g.calls) * 15
    q += adj; parts.push(`medido aqui: revisor aprovou ${Math.round(100 * g.approved / g.reviewed)}% de ${g.reviewed}${g.zero ? `, ${g.zero} chamada(s) sem mudar arquivo` : ''} (${adj >= 0 ? '+' : ''}${adj.toFixed(1)})`)
  }
  // tempo: o medido aqui (minutos por chamada) vale mais que a velocidade de saída do site quando há amostra
  const sp = g?.timed >= 10 ? Math.log2(6 / (g.min / g.timed)) : Math.log2(entry.tps / 60)
  const speed = r.speed * 10 * sp; parts.push(g?.timed >= 10 ? `${(g.min / g.timed).toFixed(1)} min por chamada aqui` : `${entry.tps} tokens/s`)
  const p = pressure(tier, quota, now) // retorno de CAPACIDADE
  const cap = tier?.api ? r.volume * entry.cpt * 4 : r.volume * Math.min(p, 2) * entry.cpt * 10
  parts.push(tier?.api ? `API: US$ ${entry.cpt} por tarefa do índice` : `cota da semana no ritmo atual: ${Math.round(p * 100)}% na renovação`)
  return { score: q + speed - cap, quality: q, parts }
}

// Monta a fila de cada papel. Um esforço por modelo (o de melhor nota no papel); até 3 modelos; papel que cruza empresas
// garante duas. Escada (fix) sai em ordem crescente de qualidade, com os melhores 3 da nota.
export function buildChains({ plans = {}, quota = {}, measured = {}, blocked = [], now = Date.now() } = {}) {
  const tierOf = (family) => PLANS[family]?.tiers.find((t) => t.id === plans[family])
  const usable = CATALOG.filter((e) => {
    const t = tierOf(e.family)
    return t?.cap > 0 && (!t.models || t.models.includes(e.model)) && !blocked.includes(e.model)
  })
  const chains = {}, why = {}
  const rate = (role) => usable.filter((e) => e.ai >= ROLES[role].minAi)
    .map((e) => ({ e, s: scoreFor(e, role, { tier: tierOf(e.family), quota: quota[e.family], measured, now }) }))
    .sort((a, b) => b.s.score - a.s.score)
  // um esforço por modelo; a 2ª posição é de outra empresa quando existe (cota ou falha de uma não para o papel)
  const pick = (rated, avoidFamily = null) => {
    const one = [...new Map(rated.map((x) => [x.e.model, x])).values()] // rated vem ordenado: o 1º de cada modelo é o melhor esforço
    const first = one.find((x) => x.e.family !== avoidFamily) || one[0]
    if (!first) return []
    const other = one.find((x) => x.e.family !== first.e.family)
    const rest = one.filter((x) => x !== first && x !== other)
    return [first, ...(other ? [other] : []), ...rest].slice(0, 3)
  }
  for (const role of Object.keys(ROLES)) {
    const rated = rate(role)
    let picked
    if (ROLES[role].ladder) {
      // escada: começa no melhor custo-benefício e sobe em inteligência (mais esforço no mesmo modelo conta como degrau)
      const base = rated[0]
      picked = base ? [base, ...rated.filter((x) => x.s.quality > base.s.quality).sort((a, b) => b.s.quality - a.s.quality).slice(0, 2).reverse()] : []
    } else picked = pick(rated, role === 'checker' ? chains.impl?.[0]?.family : null) // quem revisa não é da empresa de quem mais escreve
    chains[role] = picked.map(({ e }) => ({ family: e.family, model: e.model, effort: e.effort }))
    why[role] = picked.map(({ e, s }) => `${e.label} (${e.effort}): nota ${s.score.toFixed(1)} · ${s.parts.join(' · ')}`)
  }
  return { chains, why }
}
