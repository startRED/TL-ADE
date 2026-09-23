// Uso por empresa para o relatório (e o painel da v5): cota da semana, chamadas, partes e linhas aprovadas, dólar
// equivalente (só informativo, ADR 0032) e minutos por chamada. As linhas vão para a empresa de quem escreveu a rodada
// aprovada; as chamadas contam para a empresa de cada chamada.
import { AdeError } from '../journal/errors.ts'
import { isModelCallTelemetry } from '../telemetry/telemetry.ts'
import { FAMILIES, tierOf } from './catalog.ts'
import type { Family } from './catalog.ts'
import { capacityPressure } from './chains.ts'
import { readManualQuota, readModelSettings } from './settings.ts'

export type QuotaSource = 'official' | 'manual' | 'estimated'
export type EffectiveQuota = Partial<Record<Family, { used: number; source: QuotaSource }>>
export type CompanyUsage = {
  family: Family
  quota: { used: number; source: QuotaSource } | null
  calls: number
  unknown_cost_calls: number
  approved_stories: number
  approved_lines: number
  usd: number
  usd_per_1000_lines: number | null
  minutes_per_call: number | null
}

const WEEK_MS = 7 * 24 * 3600 * 1000

/**
 * Cota de agora por empresa, lida fora do journal: a oficial pela porta vence a manual não vencida da mesma empresa;
 * sem nenhuma, a estimativa pelo tamanho do plano (a mesma que as filas usam). Plano pago por uso não tem cota.
 */
export async function readEffectiveQuota(repoDir: string, now: number, quotaPort: { readReceipt: (p: { family: string; now: number }) => Promise<any> }): Promise<EffectiveQuota> {
  const { plans } = readModelSettings(repoDir)
  const manual = readManualQuota(repoDir, now)
  const out: EffectiveQuota = {}
  for (const family of FAMILIES) {
    const receipt = await quotaPort.readReceipt({ family, now })
    if (receipt) {
      if (typeof receipt.used_percent !== 'number') throw new AdeError('invalid_quota_receipt', `recibo oficial de ${family} sem used_percent`, 4)
      out[family] = { used: receipt.used_percent, source: 'official' }
      continue
    }
    const m = manual[family]
    if (m) {
      out[family] = { used: m.used, source: 'manual' }
      continue
    }
    const tier = tierOf(family, plans[family])
    if (tier && tier.size > 0 && !tier.api) out[family] = { used: Math.round(capacityPressure(tier, null, now) * 100), source: 'estimated' }
  }
  return out
}

/** Números por empresa das chamadas e partes da semana até `now`, com a cota efetiva recebida de fora. */
export function usageByCompany(events: Array<Record<string, any>>, now: number, quota: EffectiveQuota): CompanyUsage[] {
  const rows = new Map<Family, CompanyUsage & { timed: number; minutes: number }>()
  const row = (family: Family) => {
    let r = rows.get(family)
    if (!r) {
      r = { family, quota: quota[family] ?? null, calls: 0, unknown_cost_calls: 0, approved_stories: 0, approved_lines: 0, usd: 0, usd_per_1000_lines: null, minutes_per_call: null, timed: 0, minutes: 0 }
      rows.set(family, r)
    }
    return r
  }
  const lastWriter = new Map<string, Family>()
  const approvedWriter = new Map<string, Family>()
  for (const e of events) {
    const at = Date.parse(e.at)
    if (Number.isFinite(at) && (at > now || now - at > WEEK_MS)) continue
    const unit = String(e.unit ?? e.data?.unit ?? e.data?.story_id ?? '')
    if (isModelCallTelemetry(e)) {
      const family = String(e.data.family)
      if (!(FAMILIES as string[]).includes(family)) continue
      const r = row(family as Family)
      r.calls++
      if (typeof e.data.cost_usd === 'number') r.usd += e.data.cost_usd
      else r.unknown_cost_calls++
      if (typeof e.data.duration_ms === 'number') {
        r.timed++
        r.minutes += e.data.duration_ms / 60_000
      }
      if (!String(e.data.role).startsWith('checker')) lastWriter.set(unit, family as Family)
    } else if (e.kind === 'review_result' && e.data?.approved === true) {
      const writer = lastWriter.get(unit)
      if (writer) approvedWriter.set(unit, writer)
    } else if (e.kind === 'story_done' && (e.data?.status === 'committed' || e.data?.status === 'delivered')) {
      const writer = approvedWriter.get(unit)
      if (!writer) continue
      const r = row(writer)
      r.approved_stories++
      const { lines_added: added, lines_removed: removed } = e.data.measure ?? {}
      if (typeof added === 'number' && typeof removed === 'number') r.approved_lines += added + removed
    }
  }
  for (const family of FAMILIES) if (quota[family]) row(family)
  return FAMILIES.flatMap((family) => {
    const r = rows.get(family)
    if (!r) return []
    const { timed, minutes, ...usage } = r
    return [{
      ...usage,
      // chamada sem custo conhecido não entra como zero: o custo por linha fica desconhecido
      usd_per_1000_lines: usage.approved_lines > 0 && usage.unknown_cost_calls === 0 ? (usage.usd / usage.approved_lines) * 1000 : null,
      minutes_per_call: timed > 0 ? minutes / timed : null,
    }]
  })
}
