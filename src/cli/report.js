// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readJournal } from '../journal/journal.js'
import { projectUnits } from './project.js'
import { telemetryTokens } from '../telemetry/telemetry.js'

/**
 * Agrupa e soma contadores de telemetria de tokens por papel.
 *
 * @param {Array<Record<string, any>>} [events]
 * @returns {Array<{ role: string, calls: number, unavailable_calls: number, input: number, cache_write: number, cache_read: number, output: number, usd: number }>}
 */
export function sumTokensByRole(events = []) {
  /** @type {Record<string, { role: string, calls: number, unavailable_calls: number, input: number, cache_write: number, cache_read: number, output: number, usd: number }>} */
  const grouped = {}

  for (const event of events ?? []) {
    const tokens = event?.kind === 'telemetry' ? telemetryTokens(event.data) : null
    if (!tokens) {
      continue
    }

    const role = String(event.data.role ?? 'maker')
    if (!grouped[role]) {
      grouped[role] = {
        role,
        calls: 0,
        unavailable_calls: 0,
        input: 0,
        cache_write: 0,
        cache_read: 0,
        output: 0,
        usd: 0,
      }
    }

    const entry = grouped[role]
    entry.calls++

    if (tokens.source === 'reported') {
      entry.input += Number(tokens.input ?? 0)
      entry.cache_write += Number(tokens.cache_write ?? 0)
      entry.cache_read += Number(tokens.cache_read ?? 0)
      entry.output += Number(tokens.output ?? 0)
      if (typeof tokens.usd === 'number' && Number.isFinite(tokens.usd)) {
        entry.usd += tokens.usd
      }
    } else {
      entry.unavailable_calls++
    }
  }

  return Object.values(grouped).sort((a, b) => a.role.localeCompare(b.role))
}

/**
 * Agrupa e calcula o consumo de cota por dia UTC, janelas móveis e recibos oficiais.
 *
 * @param {Array<Record<string, any>>} [events]
 * @param {number | string | Date | (() => number)} [nowMs]
 * @returns {{
 *   daily: Array<{ day: string, family: string, role: string, quota_tokens: number, unavailable_calls: number }>,
 *   windows: Array<{ family: string, role: string, last_5h: number, last_7d: number }>,
 *   receipts: Array<{ family: string, used_percent: number, reserved_percent: number, observed_at: string, weekly_reset_at: string }>,
 *   governance_metrics: {
 *     has_official_receipt: boolean,
 *     fabricated_conversion: boolean,
 *     official_used_percent: number | null,
 *     total_quota_tokens: number,
 *     total_cost_usd: number,
 *   },
 * }}
 */
export function sumQuotaUsage(events = [], nowMs = Date.now()) {
  const referenceNow =
    typeof nowMs === 'function'
      ? nowMs()
      : typeof nowMs === 'number' && Number.isFinite(nowMs)
        ? nowMs
        : nowMs !== undefined && nowMs !== null
          ? new Date(nowMs).getTime()
          : Date.now()

  const fiveHoursMs = 5 * 60 * 60 * 1000
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

  /** @type {Map<string, { day: string, family: string, role: string, quota_tokens: number, unavailable_calls: number }>} */
  const dailyGroups = new Map()

  /** @type {Map<string, { family: string, role: string, last_5h: number, last_7d: number }>} */
  const windowGroups = new Map()

  /** @type {Map<string, { family: string, used_percent: number, reserved_percent: number, observed_at: string, weekly_reset_at: string }>} */
  const latestReceipts = new Map()

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue

    // 1. Recibos oficiais em budget_reserved
    if (event.kind === 'budget_reserved') {
      const receipt = event.data?.quota_receipt ?? event.quota_receipt
      if (receipt && receipt.source === 'official') {
        const family = receipt.family ?? event.data?.family ?? event.family
        if (family) {
          const familyKey = String(family)
          const existing = latestReceipts.get(familyKey)

          let isNewer = false
          if (!existing) {
            isNewer = true
          } else {
            const currentTime = receipt.observed_at ? new Date(receipt.observed_at).getTime() : NaN
            const existingTime = existing.observed_at ? new Date(existing.observed_at).getTime() : NaN
            if (Number.isFinite(currentTime) && Number.isFinite(existingTime)) {
              isNewer = currentTime >= existingTime
            } else if (Number.isFinite(currentTime)) {
              isNewer = true
            } else if (typeof receipt.observed_at === 'string' && typeof existing.observed_at === 'string') {
              isNewer = receipt.observed_at.localeCompare(existing.observed_at) >= 0
            } else {
              isNewer = true
            }
          }

          if (isNewer) {
            latestReceipts.set(familyKey, {
              family: familyKey,
              used_percent: receipt.used_percent,
              reserved_percent: receipt.reserved_percent,
              observed_at: receipt.observed_at,
              weekly_reset_at: receipt.weekly_reset_at,
            })
          }
        }
      }
    }

    // 2. Telemetria
    if (event.kind === 'telemetry' && event.data?.scope !== 'mission_summary') {
      const tokens = telemetryTokens(event.data) ?? event.tokens
      const family = String(event.data?.family ?? event.family ?? event.data?.tokens?.family ?? 'claude')
      const role = String(event.data?.role ?? event.role ?? 'maker')

      const rawAt = event.at ?? event.data?.at ?? event.timestamp ?? event.ts
      const eventTime = rawAt !== undefined && rawAt !== null ? new Date(rawAt).getTime() : NaN
      const day = Number.isFinite(eventTime)
        ? new Date(eventTime).toISOString().slice(0, 10)
        : 'indisponível'

      const isReported = Boolean(tokens && tokens.source === 'reported')
      const quotaTokens = isReported
        ? Number(tokens.input ?? 0) + Number(tokens.cache_read ?? 0) + Number(tokens.output ?? 0)
        : 0
      const unavailableCall = isReported ? 0 : 1

      // Agrupamento diário: dia | família | papel
      const dailyKey = `${day}|${family}|${role}`
      let dEntry = dailyGroups.get(dailyKey)
      if (!dEntry) {
        dEntry = {
          day,
          family,
          role,
          quota_tokens: 0,
          unavailable_calls: 0,
        }
        dailyGroups.set(dailyKey, dEntry)
      }
      dEntry.quota_tokens += quotaTokens
      dEntry.unavailable_calls += unavailableCall

      // Agrupamento por janela: família | papel
      const windowKey = `${family}|${role}`
      let wEntry = windowGroups.get(windowKey)
      if (!wEntry) {
        wEntry = {
          family,
          role,
          last_5h: 0,
          last_7d: 0,
        }
        windowGroups.set(windowKey, wEntry)
      }

      if (Number.isFinite(eventTime)) {
        const elapsed = referenceNow - eventTime
        if (elapsed >= 0 && elapsed <= fiveHoursMs) {
          if (isReported) {
            wEntry.last_5h += quotaTokens
          }
        }
        if (elapsed >= 0 && elapsed <= sevenDaysMs) {
          if (isReported) {
            wEntry.last_7d += quotaTokens
          }
        }
      }
    }
  }

  const daily = Array.from(dailyGroups.values()).sort(
    (a, b) => a.day.localeCompare(b.day) || a.family.localeCompare(b.family) || a.role.localeCompare(b.role),
  )

  const windows = Array.from(windowGroups.values()).sort(
    (a, b) => a.family.localeCompare(b.family) || a.role.localeCompare(b.role),
  )

  const receipts = Array.from(latestReceipts.values()).sort(
    (a, b) => a.family.localeCompare(b.family),
  )

  let totalQuotaTokens = 0
  let totalCostUsd = 0
  for (const event of events ?? []) {
    if (event?.kind === 'telemetry') {
      const tokens = telemetryTokens(event.data) ?? event.tokens
      if (tokens && tokens.source === 'reported') {
        totalQuotaTokens += Number(tokens.input ?? 0) + Number(tokens.cache_read ?? 0) + Number(tokens.output ?? 0)
        if (typeof tokens.usd === 'number' && Number.isFinite(tokens.usd)) {
          totalCostUsd += tokens.usd
        }
      }
    }
  }

  const hasOfficialReceipt = receipts.length > 0
  const officialUsedPercent = hasOfficialReceipt ? receipts[0].used_percent : null

  const governance_metrics = {
    has_official_receipt: hasOfficialReceipt,
    fabricated_conversion: false,
    official_used_percent: officialUsedPercent,
    total_quota_tokens: totalQuotaTokens,
    total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
  }

  return { daily, windows, receipts, governance_metrics }
}

/**
 * Renderiza o relatório da missão em markdown.
 *
 * @param {string} mission
 * @param {Array<{ unit: string, status: string, reason?: string | null, commit?: string | null }>} units
 * @param {Array<{ role: string, calls: number, unavailable_calls: number, input: number, cache_write: number, cache_read: number, output: number, usd: number }>} [costs]
 * @param {{
 *   daily?: Array<{ day: string, family: string, role: string, quota_tokens: number, unavailable_calls: number }>,
 *   windows?: Array<{ family: string, role: string, last_5h: number, last_7d: number }>,
 *   receipts?: Array<{ family: string, used_percent: number, reserved_percent: number, observed_at: string, weekly_reset_at: string }>,
 *   governance_metrics?: any,
 * } | null} [quota]
 * @param {Array<Record<string, any>>} [events]
 * @returns {string}
 */
export function renderReport(mission, units, costs = [], quota = null, events = []) {
  let report = `# Relatório da missão ${mission}\n\n`
  if (units.length === 0) {
    report += 'Nenhuma unidade registrada.\n'
  } else {
    report += '| unidade | estado | motivo | commit |\n| --- | --- | --- | --- |\n'
    for (const u of units) {
      const reason = u.reason ?? '-'
      const commit = u.commit ? u.commit.slice(0, 12) : '-'
      report += `| ${u.unit} | ${u.status} | ${reason} | ${commit} |\n`
    }

    report += '\n## Próximos passos\n\n'
    for (const u of units) {
      if (u.status === 'committed') {
        report += `- ${u.unit}: git merge --ff-only ade/${mission}/${u.unit}\n`
      } else if (u.status === 'awaiting_operator') {
        const reasonPart = u.reason ?? 'sem motivo'
        report += `- ${u.unit}: resolver awaiting_operator (${reasonPart})\n`
      } else {
        report += `- ${u.unit}: em andamento\n`
      }
    }
  }

  if (costs.length > 0) {
    report += '\n## Custo por papel\n\n| papel | chamadas | sem relato | input | cache_write | cache_read | output | usd |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
    for (const c of costs) {
      report += `| ${c.role} | ${c.calls} | ${c.unavailable_calls} | ${c.input} | ${c.cache_write} | ${c.cache_read} | ${c.output} | ${c.usd.toFixed(4)} |\n`
    }
  }

  if (quota) {
    report += '\n## Cota por dia UTC\n\n| dia | família | papel | cota_tokens | indisponíveis |\n| --- | --- | --- | --- | --- |\n'
    if (quota.daily && quota.daily.length > 0) {
      for (const d of quota.daily) {
        const quotaStr = d.quota_tokens > 0 ? String(d.quota_tokens) : (d.unavailable_calls > 0 ? 'indisponível' : '0')
        report += `| ${d.day} | ${d.family} | ${d.role} | ${quotaStr} | ${d.unavailable_calls} |\n`
      }
    } else {
      report += '| - | - | - | indisponível | 0 |\n'
    }

    report += '\n## Janelas de cota\n\n| família | papel | últimas 5 horas | últimos 7 dias |\n| --- | --- | --- | --- |\n'
    if (quota.windows && quota.windows.length > 0) {
      for (const w of quota.windows) {
        report += `| ${w.family} | ${w.role} | ${w.last_5h} | ${w.last_7d} |\n`
      }
    } else {
      report += '| - | - | indisponível | indisponível |\n'
    }

    report += '\n## Recibos oficiais\n\n| família | usado | reservado | observado em | reinício semanal |\n| --- | --- | --- | --- | --- |\n'
    if (quota.receipts && quota.receipts.length > 0) {
      for (const r of quota.receipts) {
        const used = r.used_percent !== null && r.used_percent !== undefined ? `${r.used_percent}%` : 'indisponível'
        const reserved = r.reserved_percent !== null && r.reserved_percent !== undefined ? `${r.reserved_percent}%` : 'indisponível'
        const observed = r.observed_at ?? 'indisponível'
        const reset = r.weekly_reset_at ?? 'indisponível'
        report += `| ${r.family} | ${used} | ${reserved} | ${observed} | ${reset} |\n`
      }
    } else {
      report += '| - | indisponível | indisponível | indisponível | indisponível |\n'
    }
  }

  report += renderParkedUnits(events)
  report += renderVisualComparison(events)

  return report
}

/**
 * Renderiza, por unidade estacionada na noite, o motivo e o caminho absoluto abrível da evidência.
 *
 * @param {Array<Record<string, any>>} [events]
 * @returns {string}
 */
export function renderParkedUnits(events = []) {
  const parked = (events || []).filter((e) => e?.kind === 'unit_parked')
  if (parked.length === 0) return ''

  let section = '\n## Unidades paradas\n\n| unidade | motivo | evidência |\n| --- | --- | --- |\n'
  for (const e of parked) {
    const unit = e.data?.unit ?? '-'
    const reason = e.data?.reason ?? '-'
    const evidence = e.data?.evidence_path ?? 'indisponível'
    section += `| ${unit} | ${reason} | ${evidence} |\n`
  }
  return section
}

/**
 * Renderiza a tabela de capturas e notas lado a lado das duas rodadas visuais (critério 11).
 *
 * @param {Array<Record<string, any>>} [events]
 * @returns {string}
 */
export function renderVisualComparison(events = []) {
  const visualEvents = (events || []).filter(
    (e) => e?.kind === 'visual_eval_done' || e?.data?.kind === 'visual_eval_done',
  )
  if (visualEvents.length === 0) return ''

  const r1Event = visualEvents.find((e) => (e.data?.round ?? e.round) === 1)
  const r2Event = visualEvents.find((e) => (e.data?.round ?? e.round) === 2)

  const r1Eval = r1Event?.data?.evaluation ?? r1Event?.evaluation
  const r2Eval = r2Event?.data?.evaluation ?? r2Event?.evaluation

  let section = '\n## Avaliação visual e capturas comparáveis\n\n'
  section += '| rota | largura | tema | captura r1 | captura r2 | nota r1 | nota r2 |\n| --- | --- | --- | --- | --- | --- | --- |\n'

  const r1Caps = r1Eval?.captures || []
  const r2Caps = r2Eval?.captures || []

  if (r1Caps.length === 0 && r2Caps.length === 0) {
    section += '| - | - | - | indisponível | indisponível | - | - |\n'
  } else {
    const allKeys = new Set([
      ...r1Caps.map((c) => `${c.route}:${c.width}:${c.theme}`),
      ...r2Caps.map((c) => `${c.route}:${c.width}:${c.theme}`),
    ])

    for (const key of allKeys) {
      const [route, width, theme] = key.split(':')
      const c1 = r1Caps.find((c) => `${c.route}:${c.width}:${c.theme}` === key)
      const c2 = r2Caps.find((c) => `${c.route}:${c.width}:${c.theme}` === key)
      const p1 = c1?.path ? `\`${c1.path}\`` : 'indisponível'
      const p2 = c2?.path ? `\`${c2.path}\`` : 'indisponível'
      const score1 = r1Eval?.final !== undefined ? String(r1Eval.final) : '-'
      const score2 = r2Eval?.final !== undefined ? String(r2Eval.final) : '-'
      section += `| ${route} | ${width} | ${theme} | ${p1} | ${p2} | ${score1} | ${score2} |\n`
    }
  }

  return section
}

/**
 * Ponto de entrada do comando `ade report`.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stdout?: { write: (s: string) => void } | ((s: string) => void),
 *   stderr?: { write: (s: string) => void } | ((s: string) => void),
 *   now?: number | (() => number),
 *   [key: string]: any,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const stdout =
    typeof deps.stdout === 'function'
      ? { write: deps.stdout }
      : (deps.stdout ?? process.stdout)
  const stderr =
    typeof deps.stderr === 'function'
      ? { write: deps.stderr }
      : (deps.stderr ?? process.stderr)

  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      mission: { type: 'string' },
      out: { type: 'string' },
      quota: { type: 'boolean' },
    },
  })

  const missionDir = values.mission ?? env.ADE_MISSION_DIR
  if (!missionDir) {
    stderr.write('uso: ade report --mission <pasta> [--out <arquivo>]\n')
    return 4
  }

  const journalPath = path.join(missionDir, 'journal.jsonl')
  if (!fs.existsSync(journalPath)) {
    stderr.write(`journal ausente: ${journalPath}\n`)
    return 4
  }

  const { events } = readJournal(journalPath)
  const mission = path.basename(missionDir)
  const outPath = path.resolve(values.out ?? path.join(missionDir, 'report.md'))

  const costs = sumTokensByRole(events)
  const now = deps.now ?? Date.now
  const nowMs = typeof now === 'function' ? now() : now

  let reportContent
  if (values.quota) {
    const quota = sumQuotaUsage(events, nowMs)
    reportContent = renderReport(mission, projectUnits(events), costs, quota, events)
  } else {
    reportContent = renderReport(mission, projectUnits(events), costs, null, events)
  }

  fs.writeFileSync(outPath, reportContent, 'utf8')
  stdout.write(`relatório: ${outPath}\n`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
