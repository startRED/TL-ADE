// API da página Modelos (v5): só expõe o que src/models já faz — settings, cota manual e oficial, filas com o porquê
// e uso por empresa — sempre sobre o repositório do projeto ativo.
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { CATALOG, FAMILIES, PLANS, ROLES, tierOf } from '../models/catalog.ts'
import type { Effort, Family, RoleId } from '../models/catalog.ts'
import { buildChains, capacityPressure, measureQuality, scoreFor } from '../models/chains.ts'
import type { QuotaReading } from '../models/chains.ts'
import {
  isEffort, isFamily, isModel, isRole, readManualQuota, readModelSettings, writeManualQuota, writeModelSettings,
} from '../models/settings.ts'
import type { ModelSettings } from '../models/settings.ts'
import { readEffectiveQuota, usageByCompany } from '../models/usage.ts'

export type QuotaPort = { readReceipt: (p: { family: string; now: number }) => Promise<any> }

const invalid = (message: string) => new AdeError('models_invalid', message, 2)
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Eventos de todas as missões do projeto, na ordem das pastas. */
function projectEvents(repoDir: string): Array<Record<string, any>> {
  const dir = path.join(repoDir, '.ade', 'missions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort().flatMap((m) => readJournal(path.join(dir, m, 'journal.jsonl')).events)
}

/** Leituras de cota com hora de renovação: a oficial pela porta vence a manual não vencida. */
async function quotaReadings(repoDir: string, now: number, port: QuotaPort): Promise<Partial<Record<Family, QuotaReading>>> {
  const quota = readManualQuota(repoDir, now)
  for (const family of FAMILIES) {
    const receipt = await port.readReceipt({ family, now })
    if (!receipt) continue
    if (typeof receipt.used_percent !== 'number') throw new AdeError('invalid_quota_receipt', `recibo oficial de ${family} sem used_percent`, 4)
    quota[family] = { used: receipt.used_percent, resets_at: receipt.weekly_reset_at, source: 'official' }
  }
  return quota
}

/** Catálogo, planos, settings, cota por empresa e a fila de cada papel com o porquê de cada posição. */
export async function readModelsView(repoDir: string, now: number, port: QuotaPort) {
  const settings = readModelSettings(repoDir)
  const readings = await quotaReadings(repoDir, now, port)
  const measured = measureQuality(projectEvents(repoDir))
  const { chains, why } = buildChains({ ...settings, quota: readings, measured, now })

  const quota: Partial<Record<Family, { used: number; resets_at: string | null; source: 'official' | 'manual' | 'plano' }>> = {}
  for (const family of FAMILIES) {
    const tier = tierOf(family, settings.plans[family])
    if (readings[family]) quota[family] = readings[family]
    else if (tier && tier.size > 0 && !tier.api) quota[family] = { used: Math.round(capacityPressure(tier, null, now) * 100), resets_at: null, source: 'plano' }
  }

  const view = {} as Record<RoleId, unknown[]>
  for (const role of Object.keys(ROLES) as RoleId[]) {
    view[role] = chains[role].map((slot, i) => {
      const e = CATALOG.find((x) => x.model === slot.model && x.effort === slot.effort)
      if (!e) throw new AdeError('models_invalid', `fila com modelo fora do catálogo: ${slot.model} ${slot.effort}`, 2)
      const tier = tierOf(slot.family, settings.plans[slot.family])
      const reading = readings[slot.family] ?? null
      const { quality } = scoreFor(e, role, { tier, reading, measured, now, fixedEffort: settings.effort[role] === e.effort })
      return {
        model_id: slot.model,
        family: slot.family,
        effort: slot.effort,
        ...(slot.reserve ? { reserve: true } : {}),
        why: {
          capacity: Math.round(capacityPressure(tier, reading, now) * 100),
          quality: Math.round(quality * 10) / 10,
          intelligence: e.intelligence,
          cost: e.costPerTask,
          note: why[role][i],
        },
      }
    })
  }
  return { catalog: CATALOG, plans: PLANS, roles: ROLES, settings, blocked: settings.blocked, quota, chains: view }
}

/** Troca os campos enviados (planos por empresa somam aos gravados); qualquer valor desconhecido recusa tudo. */
export function updateModelSettings(repoDir: string, body: unknown): ModelSettings {
  if (!isObject(body)) throw invalid('Envie um objeto com plans, blocked ou efforts.')
  const extra = Object.keys(body).filter((k) => !['plans', 'blocked', 'efforts'].includes(k))
  if (extra.length) throw invalid(`Campo desconhecido: ${extra.join(', ')}.`)
  const current = readModelSettings(repoDir)
  const next: ModelSettings = { ...current, plans: { ...current.plans } }
  if (body.plans !== undefined) {
    if (!isObject(body.plans)) throw invalid('plans deve ser um objeto empresa → plano.')
    for (const [family, plan] of Object.entries(body.plans)) {
      if (!isFamily(family)) throw invalid(`Empresa desconhecida: ${family}.`)
      if (typeof plan !== 'string' || !tierOf(family, plan)) throw invalid(`Plano desconhecido para ${family}: ${String(plan)}.`)
      next.plans[family] = plan
    }
  }
  if (body.blocked !== undefined) {
    if (!Array.isArray(body.blocked)) throw invalid('blocked deve ser uma lista de modelos.')
    for (const m of body.blocked) if (typeof m !== 'string' || !isModel(m)) throw invalid(`Modelo desconhecido: ${String(m)}.`)
    next.blocked = [...new Set(body.blocked as string[])]
  }
  if (body.efforts !== undefined) {
    if (!isObject(body.efforts)) throw invalid('efforts deve ser um objeto papel → esforço.')
    const effort: ModelSettings['effort'] = {}
    for (const [role, e] of Object.entries(body.efforts)) {
      if (!isRole(role)) throw invalid(`Papel desconhecido: ${role}.`)
      if (typeof e !== 'string' || !isEffort(e)) throw invalid(`Esforço desconhecido para ${role}: ${String(e)}.`)
      effort[role] = e as Effort
    }
    next.effort = effort
  }
  writeModelSettings(repoDir, next)
  return next
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** Cota informada à mão: percentual de 0 a 100 e renovação futura com fuso. */
export function setManualQuota(repoDir: string, body: unknown, now: number): void {
  if (!isObject(body)) throw invalid('Envie family, used e resets_at.')
  const { family, used, resets_at: resetsAt } = body
  if (typeof family !== 'string' || !isFamily(family)) throw invalid(`Empresa desconhecida: ${String(family)} (use ${FAMILIES.join(', ')}).`)
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) throw invalid(`Uso fora de 0 a 100: ${String(used)}.`)
  const at = typeof resetsAt === 'string' && ISO_INSTANT.test(resetsAt) ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(at) || at <= now) throw invalid(`Hora de renovação inválida ou já passada: ${String(resetsAt)}.`)
  writeManualQuota(repoDir, family, used, new Date(at).toISOString())
}

/** Uso por empresa do journal do projeto; `since` (AAAA-MM-DD) corta o que veio antes do dia. */
export async function readUsage(project: { id: string; path: string }, since: string | null, now: number, port: QuotaPort) {
  let events = projectEvents(project.path)
  if (since !== null) {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00.000Z`) : NaN
    if (!Number.isFinite(from)) throw invalid(`since deve ser AAAA-MM-DD: ${since}.`)
    events = events.filter((e) => Date.parse(e.at) >= from)
  }
  const companies = usageByCompany(events, now, await readEffectiveQuota(project.path, now, port))
  return { project_id: project.id, companies, usd_informative: true as const }
}
