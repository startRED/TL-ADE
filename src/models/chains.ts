// Filas de modelo por papel a partir dos planos do usuário (ADR 0033). Dois sinais separados:
//  - CAPACIDADE: quanto de cota a empresa ainda aguenta na semana, projetado pelo ritmo de gasto; pesa nos papéis de muito
//    volume e desempata modelos de inteligência parecida. O dólar não bloqueia nada (ADR 0032): na API só entra na nota.
//  - QUALIDADE: a inteligência do catálogo corrigida pelo que o modelo entregou aqui (revisor aprovou, chamada sem mudar
//    arquivo), só nos papéis de quem escreve.
import { CATALOG, EFFORTS, ROLES, tierOf } from './catalog.ts'
import type { Effort, Family, ModelEntry, RoleId, Tier } from './catalog.ts'

export type QuotaReading = { used: number; resets_at: string; source: 'official' | 'manual' }
export type ChainSlot = { family: Family; model: string; effort: Effort; reserve?: true }
export type Measured = Record<string, {
  calls: number
  reviewed: number
  approved: number
  unchanged: number
  minutesByEffort: Record<string, { timed: number; minutes: number }>
}>

const WEEK_MS = 7 * 24 * 3600 * 1000

/**
 * Fração da cota semanal que a empresa terá gasto na renovação se o ritmo seguir (1 = acaba junto com a semana).
 * Sem leitura, estima pelo tamanho do plano: plano maior pesa menos. API não tem cota: zero.
 */
export function capacityPressure(tier: Pick<Tier, 'size' | 'api'> | undefined, reading: QuotaReading | null, now: number): number {
  if (!tier || !tier.size) return Infinity
  if (tier.api) return 0
  if (reading) {
    const left = Math.min(1, Math.max(0, (Date.parse(reading.resets_at) - now) / WEEK_MS))
    // começo de semana projeta como se 10% tivessem passado: gasto cedo já é sinal
    return Math.max(0, reading.used / 100 / Math.max(1 - left, 0.1))
  }
  return Math.min(0.8, 3 / tier.size)
}

const WRITER_ROLES = new Set(['maker', ...Object.entries(ROLES).filter(([, r]) => r.writer).map(([id]) => id)])

/**
 * Qualidade medida no journal, por modelo (todos os papéis de escrever juntos; separar deixaria amostras pequenas):
 * depois de cada chamada de quem escreve, o próximo parecer do revisor da mesma parte, se a chamada mudou arquivo e o
 * tempo por esforço (um esforço não herda o tempo de outro: o Opus 5.5 max levava os minutos medidos no high).
 */
export function measureQuality(events: Array<Record<string, any>>): Measured {
  const out: Measured = {}
  // todas as chamadas de escrita da parte desde o último parecer: o parecer julga o que todas entregaram juntas
  const pending = new Map<string, string[]>()
  const changedBy = new Map<string, boolean>()
  for (const e of events) {
    const unit = String(e.unit ?? e.data?.unit ?? e.data?.story_id ?? '')
    if (e.kind === 'contain_result') {
      changedBy.set(unit, Array.isArray(e.data?.changedPaths) && e.data.changedPaths.length > 0)
      continue
    }
    if (e.kind === 'review_result') {
      for (const model of pending.get(unit) ?? []) {
        out[model].reviewed++
        if (e.data?.approved === true) out[model].approved++
      }
      pending.delete(unit)
      continue
    }
    if (e.kind !== 'telemetry' || !Array.isArray(e.data?.models) || !WRITER_ROLES.has(e.data.role)) continue
    const d = e.data
    const model = d.models.find((m: any) => m.role === 'executor')?.model_id ?? d.models[0]?.model_id
    if (typeof model !== 'string') continue
    const g = out[model] ??= { calls: 0, reviewed: 0, approved: 0, unchanged: 0, minutesByEffort: {} }
    g.calls++
    // o contain da parte vem antes da telemetria da chamada; sem ele vale o que a chamada reportou
    if (d.files_touched === 0 && changedBy.get(unit) !== true) g.unchanged++
    if (typeof d.duration_ms === 'number' && d.duration_ms > 0) {
      const t = g.minutesByEffort[typeof d.effort === 'string' ? d.effort : '-'] ??= { timed: 0, minutes: 0 }
      t.timed++
      t.minutes += d.duration_ms / 60_000
    }
    changedBy.delete(unit)
    pending.set(unit, [...(pending.get(unit) ?? []), model])
  }
  return out
}

// o journal grava o Gemini com o esforço no nome (gemini-3.8-flash-high); os outros, só o modelo
const measuredOf = (measured: Measured, e: ModelEntry) => measured[`${e.model}-${e.effort}`] ?? measured[e.model] ?? null

/** Nota de um modelo num papel, com o porquê de cada parcela. */
export function scoreFor(e: ModelEntry, role: RoleId, ctx: { tier: Tier | undefined; reading: QuotaReading | null; measured: Measured; now: number; fixedEffort?: boolean }) {
  const r = ROLES[role]
  const parts = [`inteligência ${e.intelligence}`]
  let quality = e.intelligence
  const g = r.writer ? measuredOf(ctx.measured, e) : null
  if (g && g.reviewed >= 5) {
    // aprovação do revisor contra a média, com peso pela amostra
    const w = g.reviewed / (g.reviewed + 10)
    const adj = (g.approved / g.reviewed - 0.4) * 30 * w - (g.unchanged / g.calls) * 15
    quality += adj
    parts.push(`medido aqui: revisor aprovou ${Math.round((100 * g.approved) / g.reviewed)}% de ${g.reviewed}` +
      `${g.unchanged ? `, ${g.unchanged} chamada(s) sem mudar arquivo` : ''} (${adj >= 0 ? '+' : ''}${adj.toFixed(1)})`)
  }
  // abaixo de 15 s o site não diz nada de tarefa com vários passos: modelo mais fraco paga em rodadas o que ganha em segundos
  const t = g?.minutesByEffort[e.effort] ?? g?.minutesByEffort['-']
  const timed = t !== undefined && t.timed >= 10
  // esforço fixado pelo usuário: o tempo desse esforço é escolha dele e não tira o modelo da fila
  const speed = ctx.fixedEffort ? 0 : r.speed * 10 * (timed ? Math.log2(6 / (t.minutes / t.timed)) : Math.log2(30 / Math.max(15, e.seconds)))
  parts.push(`${timed ? `${(t.minutes / t.timed).toFixed(1)} min por chamada aqui` : `${e.seconds} s por resposta`}${ctx.fixedEffort ? ' (esforço fixado pelo usuário: tempo não pesa)' : ''}`)
  const p = capacityPressure(ctx.tier, ctx.reading, ctx.now)
  const load = ctx.tier?.api ? r.volume * e.costPerTask * 4 : r.volume * Math.min(p, 2) * e.costPerTask * 10
  parts.push(ctx.tier?.api
    ? `API: US$ ${e.costPerTask} por tarefa do índice`
    : `cota projetada até a renovação: ${Math.round(p * 100)}% (${ctx.reading ? (ctx.reading.source === 'official' ? 'oficial' : 'manual') : 'estimada pelo plano'})`)
  return { score: quality + speed - load, quality, parts }
}

type Rated = { e: ModelEntry; score: number; parts: string[]; reserve?: true }

/**
 * Monta a fila de cada papel com o porquê de cada posição. Até 3 modelos distintos; um esforço por modelo, menos na
 * escada (`fix`), que pode subir o esforço do mesmo modelo; quem revisa não é da empresa que encabeça o código comum.
 */
export function buildChains({ plans = {}, quota = {}, measured = {}, blocked = [], effort = {}, now }: {
  plans?: Partial<Record<Family, string>>
  quota?: Partial<Record<Family, QuotaReading>>
  measured?: Measured
  blocked?: string[]
  effort?: Partial<Record<RoleId, Effort>>
  now: number
}): { chains: Record<RoleId, ChainSlot[]>; why: Record<RoleId, string[]> } {
  const usable = CATALOG.filter((e) => {
    const t = tierOf(e.family, plans[e.family])
    return t !== undefined && t.size > 0 && (!t.models || t.models.includes(e.model)) && !blocked.includes(e.model)
  })
  const chains = {} as Record<RoleId, ChainSlot[]>
  const why = {} as Record<RoleId, string[]>

  for (const role of Object.keys(ROLES) as RoleId[]) {
    const min = ROLES[role].minIntelligence
    const meets = (x: Rated) => x.e.intelligence >= min
    const fixed = effort[role]
    // esforço fixado: vale nos modelos que o oferecem; os outros seguem com os esforços que têm
    const offers = new Set(usable.filter((e) => e.effort === fixed).map((e) => e.model))
    // o máximo (mais caro e lento) só entra onde o usuário o fixou (ADR 0043): sozinho ele subia a escada até o max
    const auto = fixed !== 'max' && usable.some((e) => e.effort === 'max')
    const rated: Rated[] = usable
      .filter((e) => (!offers.has(e.model) || e.effort === fixed) && (e.effort !== 'max' || fixed === 'max'))
      .map((e) => ({ e, ...scoreFor(e, role, { tier: tierOf(e.family, plans[e.family]), reading: quota[e.family] ?? null, measured, now, fixedEffort: e.effort === fixed }) }))
      // quem atinge o mínimo do papel vem antes; os abaixo só completam a fila
      .sort((a, b) => Number(meets(b)) - Number(meets(a)) || b.score - a.score)
    const seen = new Set<string>()
    const one = rated.filter((x) => !seen.has(x.e.model) && Boolean(seen.add(x.e.model)))

    let picked: Rated[]
    if (ROLES[role].ladder) {
      // começa onde a escrita parou (titular do código difícil); começar no melhor custo-benefício da própria escada
      // pulava direto para o esforço máximo
      const top = chains.impl_hard[0]
      const base = rated.find((x) => top && x.e.model === top.model && x.e.effort === top.effort) ?? rated[0]
      // a reserva é de outra empresa, entra uma vez e não conta como subida: recebendo várias rodadas piorou a parte (v03-s6f)
      const spare = base && one.find((x) => x.e.family !== base.e.family)
      const models = new Set(base ? [base.e.model, ...(spare ? [spare.e.model] : [])] : [])
      const steps: Rated[] = []
      for (const x of rated) {
        if (!base || steps.length === 2) break
        if (x === base || x.e.model === spare?.e.model || x.e.intelligence < base.e.intelligence) continue
        if (!models.has(x.e.model) && models.size === 3) continue
        models.add(x.e.model)
        steps.push(x)
      }
      // a nota só escolhe quem entra; a ordem dos degraus é a inteligência do catálogo (poucas amostras medidas não fazem a
      // escada descer)
      steps.sort((a, b) => a.e.intelligence - b.e.intelligence || EFFORTS.indexOf(a.e.effort) - EFFORTS.indexOf(b.e.effort))
      picked = base ? [base, ...steps, ...(spare ? [{ ...spare, reserve: true as const }] : [])] : []
    } else if (ROLES[role].crossFamily) {
      // a fila inteira fora da empresa de quem escreve (ADR 0005): com o resto da empresa de quem escreveu, o revisor que
      // falhava deixava a parte sem revisão (m-mud7qppy, V2-03, review_failed); sem outra empresa, a fila fica vazia
      const writer = chains.impl[0]?.family
      const good = one.filter((x) => x.e.family !== writer)
      const first = good[0]
      // a 2ª de uma terceira empresa quando existe, sem passar quem atinge o mínimo para trás de quem não atinge
      const second = good.find((x) => x !== first && x.e.family !== first.e.family && (meets(x) || !good[1] || !meets(good[1]))) ?? good[1]
      const top = [first, second].filter((x): x is Rated => x !== undefined)
      picked = [...top, ...good.filter((x) => !top.includes(x))].slice(0, 3)
    } else {
      // a 2ª posição é de outra empresa quando existe (cota ou falha de uma não para o papel), sem passar quem atinge o
      // mínimo para trás de quem não atinge
      const first = one[0]
      const second = one.find((x) => x !== first && x.e.family !== first.e.family && (meets(x) || !one[1] || !meets(one[1])))
      const top = [first, second].filter((x): x is Rated => x !== undefined)
      picked = [...top, ...one.filter((x) => !top.includes(x))].slice(0, 3)
    }
    chains[role] = picked.map(({ e, reserve }) => ({ family: e.family, model: e.model, effort: e.effort, ...(reserve ? { reserve } : {}) }))
    why[role] = picked.map(({ e, score, parts, reserve }) =>
      `${e.label} (${e.effort})${reserve ? ', reserva' : ''}: nota ${score.toFixed(1)} · ${parts.join(' · ')}`)
    // na primeira linha, para não mudar quantas linhas o porquê tem nem a ordem delas
    if (auto && why[role][0]) why[role][0] += ' · esforço máximo fora da escolha automática'
  }
  return { chains, why }
}
