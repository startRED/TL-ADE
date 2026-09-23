// Onde moram as escolhas do usuário sobre modelos (ADR 0033): planos, bloqueios e esforço por papel na chave `models` de
// .ade/config.json; a cota informada à mão em .ade/quota-manual.json, fora do config, porque o resumo do config entra no
// carimbo da missão e mudar a cota no meio de uma missão não pode fazer a retomada recusar a versão.
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { CATALOG, EFFORTS, FAMILIES, PLANS, ROLES, tierOf } from './catalog.ts'
import type { Effort, Family, RoleId } from './catalog.ts'
import type { QuotaReading } from './chains.ts'

export type ModelSettings = { plans: Partial<Record<Family, string>>; blocked: string[]; effort: Partial<Record<RoleId, Effort>> }

const invalid = (message: string) => new AdeError('models_invalid', message, 2)

export const isFamily = (v: string): v is Family => (FAMILIES as string[]).includes(v)
export const isEffort = (v: string): v is Effort => (EFFORTS as string[]).includes(v)
export const isRole = (v: string): v is RoleId => Object.hasOwn(ROLES, v)
export const isModel = (v: string) => CATALOG.some((e) => e.model === v)

function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {}
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('esperado um objeto')
    return doc
  } catch (err) {
    throw new AdeError('config_invalid', `${path.basename(file)} inválido: ${err instanceof Error ? err.message : String(err)}`, 2)
  }
}

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

const configPath = (repoDir: string) => path.join(repoDir, '.ade', 'config.json')
const manualPath = (repoDir: string) => path.join(repoDir, '.ade', 'quota-manual.json')

/** Planos, bloqueios e esforço por papel; ausentes são vazios, valores desconhecidos são recusados. */
export function readModelSettings(repoDir: string): ModelSettings {
  const m = readJson(configPath(repoDir)).models ?? {}
  const plans: ModelSettings['plans'] = {}
  for (const [family, plan] of Object.entries(m.plans ?? {})) {
    if (!isFamily(family) || !tierOf(family, String(plan))) throw invalid(`models.plans.${family} = ${String(plan)} desconhecido`)
    plans[family] = String(plan)
  }
  const effort: ModelSettings['effort'] = {}
  for (const [role, e] of Object.entries(m.effort ?? {})) {
    if (!isRole(role) || !isEffort(String(e))) throw invalid(`models.effort.${role} = ${String(e)} desconhecido`)
    effort[role] = e as Effort
  }
  if (!Array.isArray(m.blocked ?? [])) throw invalid('models.blocked deve ser uma lista')
  return { plans, blocked: (m.blocked ?? []).map(String), effort }
}

/** Grava a chave `models` de .ade/config.json sem tocar nas outras. */
export function writeModelSettings(repoDir: string, settings: ModelSettings): void {
  const doc = readJson(configPath(repoDir))
  writeJson(configPath(repoDir), { ...doc, models: settings })
}

/** Cotas informadas à mão que ainda não passaram da renovação; vencida dá lugar à estimativa pelo plano. */
export function readManualQuota(repoDir: string, now: number): Partial<Record<Family, QuotaReading>> {
  const out: Partial<Record<Family, QuotaReading>> = {}
  for (const [family, r] of Object.entries(readJson(manualPath(repoDir)))) {
    if (!isFamily(family) || typeof r?.used !== 'number' || !Number.isFinite(Date.parse(r?.resets_at))) {
      throw invalid(`quota-manual.json: leitura de ${family} inválida`)
    }
    if (Date.parse(r.resets_at) > now) out[family] = { used: r.used, resets_at: r.resets_at, source: 'manual' }
  }
  return out
}

export function writeManualQuota(repoDir: string, family: Family, used: number, resetsAt: string): void {
  const doc = readJson(manualPath(repoDir))
  writeJson(manualPath(repoDir), { ...doc, [family]: { used, resets_at: resetsAt, source: 'manual' } })
}

export const planLabel = (family: Family, plan: string | undefined) =>
  `${PLANS[family].label}: ${tierOf(family, plan ?? 'none')?.label ?? 'Não tenho'}`
