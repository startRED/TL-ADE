import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createLocalQuotaPort } from '../adapters/local/quota.ts'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { FAMILIES, PLANS, ROLES, tierOf } from '../models/catalog.ts'
import type { Family } from '../models/catalog.ts'
import { buildChains, measureQuality } from '../models/chains.ts'
import type { QuotaReading } from '../models/chains.ts'
import {
  isEffort, isFamily, isModel, isRole, planLabel, readManualQuota, readModelSettings, writeManualQuota, writeModelSettings,
} from '../models/settings.ts'
import { exitCodeOf } from './exit-codes.ts'

const USAGE = 'uso: ade models [plan <familia> <plano> | block <modelo> | unblock <modelo> | effort <papel> <esforco> | quota <familia> <percentual> --resets <iso>] [--repo <pasta>]\n'

const invalid = (message: string) => new AdeError('models_invalid', message, 2)
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10).split('-').reverse().slice(0, 2).join('/')
/** Instante ISO com fuso (Z ou ±hh:mm) e data de calendário real: o Date.parse leva 31/02 para 03/03 calado. */
function isIsoInstant(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(s)
  if (!m) return false
  const [y, mo, d, h, mi, sec = '0', oh = '0', om = '0'] = m.slice(1)
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec))
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d && t.getUTCHours() === +h &&
    t.getUTCMinutes() === +mi && t.getUTCSeconds() === +sec && +oh <= 23 && +om <= 59
}
const describeQuota = (r: QuotaReading) => `${r.used}% (${r.source === 'official' ? 'oficial' : 'manual'}, renova ${day(r.resets_at)})`

/**
 * Cota considerada por empresa: a leitura oficial pela porta local vence a manual não vencida da mesma empresa.
 */
async function effectiveQuota(repoDir: string, now: number, quotaPort: { readReceipt: (p: { family: string; now: number }) => Promise<any> }) {
  const quota = readManualQuota(repoDir, now)
  for (const family of FAMILIES) {
    const receipt = await quotaPort.readReceipt({ family, now })
    if (receipt && typeof receipt.used_percent === 'number') {
      quota[family] = { used: receipt.used_percent, resets_at: receipt.weekly_reset_at, source: 'official' }
    }
  }
  return quota
}

/**
 * CLI dos modelos: `ade models` mostra planos, cota e filas com o porquê; os subcomandos mudam a chave `models` de
 * .ade/config.json ou a cota informada à mão (.ade/quota-manual.json).
 */
export async function main(argv: string[], deps: {
    stdout?: { write: (s: string) => void }
    stderr?: { write: (s: string) => void }
    env?: Record<string, string | undefined>
    now?: () => number
    quotaPort?: { readReceipt: (p: { family: string; now: number }) => Promise<any> }
} = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { repo: { type: 'string' }, resets: { type: 'string' } },
    })
    const repoDir = parsed.values.repo ?? process.cwd()
    const now = deps.now?.() ?? Date.now()
    const [sub, a, b, ...extra] = parsed.positionals
    const settings = readModelSettings(repoDir)

    if (sub === undefined) {
      const home = deps.env?.ADE_HOME ?? process.env.ADE_HOME ?? os.homedir()
      const quota = await effectiveQuota(repoDir, now, deps.quotaPort ?? createLocalQuotaPort({ receiptPath: path.join(home, '.ade', 'quota-receipt.json') }))
      const missionsDir = path.join(repoDir, '.ade', 'missions')
      const events = existsSync(missionsDir)
        ? readdirSync(missionsDir).sort().flatMap((m) => readJournal(path.join(missionsDir, m, 'journal.jsonl')).events)
        : []
      const { chains, why } = buildChains({ ...settings, quota, measured: measureQuality(events), now })
      stdout.write('Planos e cota:\n')
      for (const family of FAMILIES) {
        const plan = settings.plans[family]
        const r = quota[family]
        const cota = !plan || plan === 'none' ? '' : tierOf(family, plan)?.api ? ' · paga por uso' : ` · cota ${r ? describeQuota(r) : 'estimada pelo plano'}`
        stdout.write(`  ${planLabel(family, plan)}${cota}\n`)
      }
      if (settings.blocked.length) stdout.write(`Bloqueados: ${settings.blocked.join(', ')}\n`)
      stdout.write('Filas:\n')
      for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
        stdout.write(`  ${ROLES[role].label} (${role})${settings.effort[role] ? `, esforço ${settings.effort[role]}` : ''}:\n`)
        if (chains[role].length === 0) stdout.write('    nenhum modelo disponível\n')
        why[role].forEach((w, i) => stdout.write(`    ${i + 1}. ${w}\n`))
      }
      return 0
    }

    const need = (n: number) => {
      if ([a, b].slice(0, n).some((v) => v === undefined) || [a, b].slice(n).some((v) => v !== undefined) || extra.length) throw new AdeError('usage', USAGE.trimEnd(), 4)
    }
    const family = (v: string) => {
      if (!isFamily(v)) throw invalid(`empresa desconhecida: ${v} (use ${FAMILIES.join(', ')})`)
      return v
    }

    if (sub === 'plan') {
      need(2)
      const f = family(a)
      if (!tierOf(f, b)) throw invalid(`plano desconhecido para ${f}: ${b} (use ${PLANS[f].tiers.map((t) => t.id).join(', ')})`)
      writeModelSettings(repoDir, { ...settings, plans: { ...settings.plans, [f]: b } })
      stdout.write(`${planLabel(f, b)}\n`)
      return 0
    }
    if (sub === 'block' || sub === 'unblock') {
      need(1)
      if (!isModel(a)) throw invalid(`modelo desconhecido: ${a}`)
      const blocked = settings.blocked.filter((m) => m !== a)
      writeModelSettings(repoDir, { ...settings, blocked: sub === 'block' ? [...blocked, a] : blocked })
      stdout.write(`${a} ${sub === 'block' ? 'bloqueado' : 'desbloqueado'}\n`)
      return 0
    }
    if (sub === 'effort') {
      need(2)
      if (!isRole(a)) throw invalid(`papel desconhecido: ${a} (use ${Object.keys(ROLES).join(', ')})`)
      if (!isEffort(b)) throw invalid(`esforço desconhecido: ${b} (use low, medium, high, xhigh ou max)`)
      writeModelSettings(repoDir, { ...settings, effort: { ...settings.effort, [a]: b } })
      stdout.write(`${ROLES[a].label}: esforço ${b}\n`)
      return 0
    }
    if (sub === 'quota') {
      need(2)
      const f: Family = family(a)
      const used = b.trim() === '' ? NaN : Number(b)
      if (!Number.isFinite(used) || used < 0 || used > 100) throw invalid(`percentual fora de 0 a 100: ${b}`)
      const resets = parsed.values.resets
      if (resets === undefined || !isIsoInstant(resets)) throw invalid(`data de renovação inválida: ${resets ?? '(faltou --resets)'}`)
      const resetsAt = new Date(resets).toISOString()
      writeManualQuota(repoDir, f, used, resetsAt)
      stdout.write(`${PLANS[f].label}: ${describeQuota({ used, resets_at: resetsAt, source: 'manual' })}\n`)
      return 0
    }
    stderr.write(USAGE)
    return 4
  } catch (err) {
    stderr.write(`ade models: ${err instanceof Error ? err.message : String(err)}\n`)
    return exitCodeOf(err)
  }
}
